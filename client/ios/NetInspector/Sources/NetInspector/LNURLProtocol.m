//
//  LNURLProtocol.m
//  NetInspector
//
//  Recording URLProtocol.
//
//  Layout:
//    - A single shared NSURLSession (connection reuse) whose delegate is a
//      router that forwards callbacks to the LNURLProtocol instance
//      associated with each task (objc associated objects).
//    - All delegate callbacks + start/stop run on one serial dispatch queue
//      (the session's delegate queue underlying queue), so instance state
//      needs no extra locking.
//    - Recursion protection: the request we forward to the inner session is
//      tagged with a marker property; +canInitWithRequest: skips marked
//      requests. Redirected requests get the marker stripped before being
//      handed back to the loading system so each hop is recorded.
//

#import "LNURLProtocol.h"
#import "LNNetInspector.h"
#import "LNNetInspector+Internal.h"
#import "LNBodyCoding.h"
#import <objc/runtime.h>

static NSString * const kLNHandledMarkerKey = @"netinspector.handled";

static dispatch_queue_t LNSharedQueue(void) {
    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("netinspector.protocol", DISPATCH_QUEUE_SERIAL);
    });
    return queue;
}

#pragma mark - Helpers

static NSDictionary *LNFlattenHeaders(NSDictionary *headers) {
    if (![headers isKindOfClass:[NSDictionary class]] || headers.count == 0) return @{};
    NSMutableDictionary *out = [NSMutableDictionary dictionaryWithCapacity:headers.count];
    [headers enumerateKeysAndObjectsUsingBlock:^(NSString *key, id value, BOOL *stop) {
        if ([value isKindOfClass:[NSArray class]]) {
            out[key] = [(NSArray *)value componentsJoinedByString:@", "];
        } else {
            out[key] = [NSString stringWithFormat:@"%@", value];
        }
    }];
    return out;
}

static long long LNMillis(NSDate *date) {
    return (long long)llround(date.timeIntervalSince1970 * 1000.0);
}

#pragma mark - LNURLProtocol internals (visible to the router below)

@interface LNURLProtocol ()
@property (nonatomic, strong, nullable) NSURLSessionDataTask *task;
@property (nonatomic, strong, nullable) NSURLResponse *response;
@property (nonatomic, strong, nullable) NSMutableData *responseData;
@property (nonatomic, assign) unsigned long long responseTotal;
@property (nonatomic, strong, nullable) NSDate *startDate;
@property (nonatomic, strong, nullable) NSData *requestBody;      // capped copy
@property (nonatomic, assign) unsigned long long requestBodySize; // true size
@property (nonatomic, copy, nullable) NSString *tempBodyPath;     // spilled body (huge uploads)
@property (nonatomic, assign) BOOL redirected;
@property (nonatomic, assign) BOOL recorded;
@property (nonatomic, assign) BOOL stopped;

// Called by LNProtocolRouter on LNSharedQueue
- (void)internal_didReceiveResponse:(NSURLResponse *)response
                   completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler;
- (void)internal_didReceiveData:(NSData *)data;
- (void)internal_didCompleteWithError:(nullable NSError *)error;
- (void)internal_redirectWithResponse:(NSHTTPURLResponse *)response
                           newRequest:(NSURLRequest *)newRequest
                      completionHandler:(void (^)(NSURLRequest * _Nullable))completionHandler;
- (void)internal_challenge:(NSURLAuthenticationChallenge *)challenge
         completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential * _Nullable))completionHandler;
- (void)internal_needNewBodyStream:(void (^)(NSInputStream * _Nullable))completionHandler;
- (void)internal_recordWithResponse:(nullable NSURLResponse *)response error:(nullable NSError *)error;
@end

#pragma mark - Router

static void *kLNTaskProtocolKey = &kLNTaskProtocolKey;

// Forwards NSURLSession delegate callbacks to the owning LNURLProtocol.
// All parameters are "untyped" (NSURLSessionTask instead of the iOS-13-only
// subclasses) purely so this file compiles at any deployment target.
@interface LNProtocolRouter : NSObject <NSURLSessionDataDelegate, NSURLSessionTaskDelegate, NSURLSessionDelegate>
@end

@implementation LNProtocolRouter

- (LNURLProtocol *)protocolForTask:(NSURLSessionTask *)task {
    return objc_getAssociatedObject(task, kLNTaskProtocolKey);
}

- (void)URLSession:(NSURLSession *)session
              dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveResponse:(NSURLResponse *)response
     completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    LNURLProtocol *proto = [self protocolForTask:dataTask];
    if (proto) {
        [proto internal_didReceiveResponse:response completionHandler:completionHandler];
    } else {
        completionHandler(NSURLSessionResponseCancel);
    }
}

- (void)URLSession:(NSURLSession *)session
          dataTask:(NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data {
    LNURLProtocol *proto = [self protocolForTask:dataTask];
    if (proto) [proto internal_didReceiveData:data];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(nullable NSError *)error {
    LNURLProtocol *proto = [self protocolForTask:task];
    if (proto) [proto internal_didCompleteWithError:error];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
willPerformHTTPRedirection:(NSHTTPURLResponse *)response
        newRequest:(NSURLRequest *)request
 completionHandler:(void (^)(NSURLRequest * _Nullable))completionHandler {
    LNURLProtocol *proto = [self protocolForTask:task];
    if (proto) {
        [proto internal_redirectWithResponse:response newRequest:request completionHandler:completionHandler];
    } else {
        completionHandler(nil);
    }
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
 completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential * _Nullable))completionHandler {
    LNURLProtocol *proto = [self protocolForTask:task];
    if (proto) {
        [proto internal_challenge:challenge completionHandler:completionHandler];
    } else {
        completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
    }
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
needNewBodyStreamFromRequest:(NSURLRequest *)request
          completionHandler:(void (^)(NSInputStream * _Nullable))completionHandler {
    LNURLProtocol *proto = [self protocolForTask:task];
    if (proto) {
        [proto internal_needNewBodyStream:completionHandler];
    } else {
        completionHandler(nil);
    }
}

// Session-level challenges (rare without a task): default handling.
- (void)URLSession:(NSURLSession *)session
didReceiveChallenge:(NSURLAuthenticationChallenge *)challenge
completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential * _Nullable))completionHandler {
    completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
}

@end

#pragma mark - LNURLProtocol

@implementation LNURLProtocol

+ (BOOL)canInitWithRequest:(NSURLRequest *)request {
    if (![LNNetInspector shared].enabled) return NO;
    if ([NSURLProtocol propertyForKey:kLNHandledMarkerKey inRequest:request] != nil) return NO;

    NSURL *url = request.URL;
    if (!url) return NO;
    NSString *scheme = url.scheme.lowercaseString;
    if (![scheme isEqualToString:@"http"] && ![scheme isEqualToString:@"https"]) return NO;

    // WebSocket handshakes upgrade the connection — leave them alone.
    NSString *upgrade = request.allHTTPHeaderFields[@"Upgrade"];
    if (upgrade.length > 0 && [upgrade.lowercaseString containsString:@"websocket"]) return NO;

    return [[LNNetInspector shared] shouldCaptureURL:url];
}

+ (NSURLRequest *)canonicalRequestForRequest:(NSURLRequest *)request {
    return request;
}

+ (NSURLSession *)sharedInnerSession {
    static NSURLSession *session;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        LNProtocolRouter *router = [[LNProtocolRouter alloc] init];

        NSOperationQueue *delegateQueue = [[NSOperationQueue alloc] init];
        delegateQueue.maxConcurrentOperationCount = 1;
        delegateQueue.underlyingQueue = LNSharedQueue();
        delegateQueue.name = @"netinspector.protocol.delegates";

        NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        if (config.protocolClasses) {
            NSMutableArray *pcs = [config.protocolClasses mutableCopy];
            [pcs removeObject:self]; // never intercept our own traffic via class list
            config.protocolClasses = pcs;
        }
        config.URLCache = nil;
        config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
        config.timeoutIntervalForRequest = 60.0;

        session = [NSURLSession sessionWithConfiguration:config
                                                delegate:router
                                           delegateQueue:delegateQueue];
        // Keep the session alive forever; it is shared by every request.
        objc_setAssociatedObject([LNURLProtocol class], "netinspector.session", session, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    });
    return session;
}

- (void)startLoading {
    LNNetInspector *inspector = [LNNetInspector shared];
    dispatch_async(LNSharedQueue(), ^{
        if (self.stopped || self.task) return;

        self.startDate = [NSDate date];
        NSURLRequest *request = self.request;

        NSMutableURLRequest *loadRequest = [request mutableCopy];
        [NSURLProtocol setProperty:@YES forKey:kLNHandledMarkerKey inRequest:loadRequest];

        // ---- request body capture ------------------------------------
        NSData *body = request.HTTPBody;
        unsigned long long bodySize = body ? (unsigned long long)body.length : 0;
        if (!body && request.HTTPBodyStream) {
            // The loading system moved the body into a stream (multipart
            // uploads, or any session-created request). Buffer it: small
            // bodies stay in memory, huge ones spill to a temp file so the
            // forwarded request stays byte-complete.
            LNBufferedBody *buffered = [LNBodyCoding bufferBodyStream:request.HTTPBodyStream
                                                      maxInMemoryBytes:inspector.maxStreamBodyBytes];
            bodySize = buffered.totalSize;
            if (buffered.data) {
                loadRequest.HTTPBody = buffered.data;
                body = buffered.data;
            } else if (buffered.tempPath.length > 0) {
                loadRequest.HTTPBodyStream = [NSInputStream inputStreamWithFileAtPath:buffered.tempPath];
                body = buffered.prefix;
                self.tempBodyPath = buffered.tempPath;
            }
        }
        self.requestBodySize = bodySize;
        NSUInteger captureLimit = inspector.maxBodyCaptureBytes;
        if (captureLimit > 0 && body.length > captureLimit) {
            body = [body subdataWithRange:NSMakeRange(0, captureLimit)];
        }
        self.requestBody = body;

        NSURLSessionDataTask *task = [[[self class] sharedInnerSession] dataTaskWithRequest:loadRequest];
        objc_setAssociatedObject(task, kLNTaskProtocolKey, self, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        self.task = task;
        [task resume];
    });
}

- (void)stopLoading {
    dispatch_async(LNSharedQueue(), ^{
        self.stopped = YES;
        [self internal_finishTask];
        if (!self.recorded && !self.redirected) {
            NSError *cancelled = [NSError errorWithDomain:NSURLErrorDomain
                                                     code:NSURLErrorCancelled
                                                 userInfo:nil];
            [self internal_recordWithResponse:self.response error:cancelled];
        }
    });
}

/** Cancels the inner task, detaches from the router and drops the spill file. */
- (void)internal_finishTask {
    if (self.task) {
        objc_setAssociatedObject(self.task, kLNTaskProtocolKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        [self.task cancel];
        self.task = nil;
    }
    if (self.tempBodyPath.length > 0) {
        [[NSFileManager defaultManager] removeItemAtPath:self.tempBodyPath error:nil];
        self.tempBodyPath = nil;
    }
}

#pragma mark Router callbacks (LNSharedQueue)

- (void)internal_didReceiveResponse:(NSURLResponse *)response
                  completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    self.response = response;
    self.responseData = [NSMutableData data];
    self.responseTotal = 0;

    NSURLCacheStoragePolicy policy = NSURLCacheStorageAllowed;
    if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
        NSString *cacheControl = ((NSHTTPURLResponse *)response).allHeaderFields[@"Cache-Control"];
        if (cacheControl.length > 0 && [cacheControl.lowercaseString containsString:@"no-store"]) {
            policy = NSURLCacheStorageNotAllowed;
        }
    }
    if (self.client) [self.client URLProtocol:self didReceiveResponse:response cacheStoragePolicy:policy];
    completionHandler(NSURLSessionResponseAllow);
}

- (void)internal_didReceiveData:(NSData *)data {
    self.responseTotal += (unsigned long long)data.length;

    NSUInteger captureLimit = [LNNetInspector shared].maxBodyCaptureBytes;
    if (self.responseData.length < captureLimit) {
        NSUInteger remaining = captureLimit - self.responseData.length;
        if (data.length <= remaining) {
            [self.responseData appendData:data];
        } else {
            [self.responseData appendData:[data subdataWithRange:NSMakeRange(0, remaining)]];
        }
    }
    // Always forward the full data to the app — capture cap is display-only.
    if (self.client) [self.client URLProtocol:self didLoadData:data];
}

- (void)internal_didCompleteWithError:(nullable NSError *)error {
    [self internal_finishTask];

    if (self.redirected || self.recorded) return;

    if (error) {
        if (self.client) [self.client URLProtocol:self didFailWithError:error];
    } else {
        if (self.client) [self.client URLProtocolDidFinishLoading:self];
    }
    [self internal_recordWithResponse:self.response error:error];
}

- (void)internal_redirectWithResponse:(NSHTTPURLResponse *)response
                          newRequest:(NSURLRequest *)newRequest
                     completionHandler:(void (^)(NSURLRequest * _Nullable))completionHandler {
    self.redirected = YES;

    // Record the 3xx hop as its own event; the Location target comes back
    // through +canInitWithRequest: as a fresh request.
    [self internal_recordWithResponse:response error:nil];

    [self internal_finishTask];

    // Strip our marker so the redirected request gets intercepted again.
    NSMutableURLRequest *forwarded = [newRequest mutableCopy];
    [NSURLProtocol removePropertyForKey:kLNHandledMarkerKey inRequest:forwarded];

    if (self.client) {
        [self.client URLProtocol:self wasRedirectedToRequest:forwarded redirectResponse:response];
    }
    completionHandler(nil); // don't let the inner session follow the redirect itself
}

- (void)internal_challenge:(NSURLAuthenticationChallenge *)challenge
         completionHandler:(void (^)(NSURLSessionAuthChallengeDisposition, NSURLCredential * _Nullable))completionHandler {
    if (self.client) [self.client URLProtocol:self didReceiveAuthenticationChallenge:challenge];
    completionHandler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
}

- (void)internal_needNewBodyStream:(void (^)(NSInputStream * _Nullable))completionHandler {
    if (self.tempBodyPath.length > 0) {
        // Spilled huge body — serve a fresh stream from the temp file.
        completionHandler([NSInputStream inputStreamWithFileAtPath:self.tempBodyPath]);
    } else {
        completionHandler(self.request.HTTPBodyStream);
    }
}

#pragma mark Recording

- (void)internal_recordWithResponse:(nullable NSURLResponse *)response error:(nullable NSError *)error {
    if (self.recorded) return;
    self.recorded = YES;

    LNNetInspector *inspector = [LNNetInspector shared];
    NSHTTPURLResponse *http = [response isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)response : nil;

    NSDictionary *reqBody = [LNBodyCoding payloadForData:self.requestBody
                                            originalSize:self.requestBodySize
                                                  limit:inspector.maxBodyCaptureBytes];
    NSDictionary *resBody = [LNBodyCoding payloadForData:self.responseData
                                            originalSize:self.responseTotal
                                                  limit:inspector.maxBodyCaptureBytes];

    NSDate *now = [NSDate date];
    NSDate *start = self.startDate ?: now;
    double durationMs = MAX(0.0, [now timeIntervalSinceDate:start] * 1000.0);

    NSDictionary *requestHeaders = LNFlattenHeaders(self.request.allHTTPHeaderFields);
    NSDictionary *responseHeaders = http ? LNFlattenHeaders(http.allHeaderFields) : @{};

    NSMutableDictionary *event = [NSMutableDictionary dictionary];
    event[@"id"] = [[NSUUID UUID] UUIDString];
    event[@"timestamp"] = @(LNMillis(start));
    event[@"completedAt"] = @(LNMillis(now));
    event[@"durationMs"] = @(durationMs);
    event[@"url"] = self.request.URL.absoluteString ?: @"";
    event[@"method"] = self.request.HTTPMethod ?: @"GET";
    event[@"requestHeaders"] = requestHeaders;
    event[@"requestContentType"] = requestHeaders[@"Content-Type"] ?: @"";
    event[@"requestBody"] = reqBody[@"body"];
    event[@"requestBodyEncoding"] = reqBody[@"encoding"];
    event[@"requestBodySize"] = reqBody[@"size"];
    event[@"requestBodyTruncated"] = reqBody[@"truncated"];
    if (http) {
        event[@"statusCode"] = @(http.statusCode);
        event[@"responseHeaders"] = responseHeaders;
        event[@"responseContentType"] = responseHeaders[@"Content-Type"] ?: @"";
        event[@"responseMimeType"] = http.MIMEType ?: @"";
    } else {
        event[@"statusCode"] = [NSNull null];
        event[@"responseHeaders"] = @{};
        event[@"responseContentType"] = @"";
        event[@"responseMimeType"] = @"";
    }
    event[@"responseBody"] = resBody[@"body"];
    event[@"responseBodyEncoding"] = resBody[@"encoding"];
    event[@"responseBodySize"] = resBody[@"size"];
    event[@"responseBodyTruncated"] = resBody[@"truncated"];
    event[@"error"] = error.localizedDescription.length > 0 ? error.localizedDescription : [NSNull null];
    event[@"fromCache"] = @NO;

    [inspector recordEvent:event];
}

@end
