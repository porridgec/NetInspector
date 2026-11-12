//
//  LNNetInspector.h
//  NetInspector
//
//  Public facade of the LAN network inspector.
//
//  Swift:
//      LNNetInspector.shared().host = "192.168.1.8"
//      LNNetInspector.shared().start()
//
//  Objective-C:
//      [[LNNetInspector shared] startWithHost:@"192.168.1.8" port:9090];
//
//  Captures URLSession / NSURLConnection traffic (including Alamofire,
//  AFNetworking and other libraries built on top of URL Loading System)
//  and streams it live to the NetInspector dashboard on your Mac.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface LNNetInspector : NSObject

- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;

+ (instancetype)shared;

#pragma mark - Configuration (before -start)

/// Mac server IP, e.g. @"192.168.1.8".
@property (nonatomic, copy, nullable) NSString *host;

/// Mac server port. Default 9090.
@property (nonatomic, assign) NSUInteger port;

/// Hosts never captured. Exact match, or wildcard like @"*.example.com".
/// The dashboard host itself is always ignored (feedback-loop protection).
@property (nonatomic, copy) NSArray<NSString *> *ignoredHosts;

/// Optional access token — must match the Mac server's TOKEN env var
/// (TOKEN=xxx npm start). Sent as ?token= on the WebSocket URL and as
/// the x-ni-token header on the HTTP fallback channel.
@property (nonatomic, copy, nullable) NSString *authToken;

/// Max bytes kept per request/response body (display only). Default 256 KiB.
@property (nonatomic, assign) NSUInteger maxBodyCaptureBytes;

/// Hard cap when buffering streaming request bodies. Default 32 MiB.
@property (nonatomic, assign) NSUInteger maxStreamBodyBytes;

/// Max events persisted on disk while offline. Default 500.
@property (nonatomic, assign) NSUInteger offlineQueueCapacity;

#pragma mark - Lifecycle

/// Starts interception + WebSocket streaming. Idempotent.
- (void)start;

/// Convenience: configure and start in one call.
- (void)startWithHost:(NSString *)host port:(NSUInteger)port;

/// Stops interception and closes the socket. Queued events stay on disk.
- (void)stop;

- (BOOL)isRunning;

@end

NS_ASSUME_NONNULL_END
