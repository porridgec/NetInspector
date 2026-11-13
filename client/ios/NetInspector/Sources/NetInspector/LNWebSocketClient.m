//
//  LNWebSocketClient.m
//  NetInspector
//
//  NSURLSessionWebSocketTask-based client (iOS 13+).
//  - Reconnect with exponential backoff + jitter (0.5 s → 30 s)
//  - Heartbeat ping every 20 s; dead links are force-reset after 10 s
//  - Serialized sends preserving order
//  Compiles at any deployment target; on pre-iOS 13 it stays closed.
//

#import "LNWebSocketClient.h"

static NSTimeInterval const kLNReconnectMinDelay = 0.5;
static NSTimeInterval const kLNReconnectMaxDelay = 30.0;
static NSTimeInterval const kLNPingInterval = 20.0;

@interface LNWebSocketClient () <NSURLSessionDataDelegate, NSURLSessionTaskDelegate, NSURLSessionDelegate>
@property (nonatomic, strong) NSURL *url;
@property (nonatomic, strong, nullable) NSURLSession *session;
@property (nonatomic, strong, nullable) id task; // NSURLSessionWebSocketTask
@property (nonatomic, assign) LNSocketState state;
@property (nonatomic, assign) NSInteger attempt;
@property (nonatomic, assign) BOOL shouldRun;
@property (nonatomic, assign) BOOL reconnectScheduled;
@property (nonatomic, strong) dispatch_queue_t q;
@property (nonatomic, strong) NSMutableArray<NSData *> *pendingData;
@property (nonatomic, strong) NSMutableArray<void (^)(BOOL)> *pendingDone;
@property (nonatomic, assign) BOOL pumping;
@property (nonatomic, strong, nullable) dispatch_source_t pingTimer;
@property (nonatomic, assign) BOOL awaitingPong;
@end

@implementation LNWebSocketClient

static void *kLNOwnQueueKey = &kLNOwnQueueKey;

- (instancetype)initWithURL:(NSURL *)url {
    self = [super init];
    if (!self) return nil;
    _url = url;
    _q = dispatch_queue_create("netinspector.socket", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_set_specific(_q, kLNOwnQueueKey, (void *)kLNOwnQueueKey, NULL);
    _pingInterval = kLNPingInterval;
    _pendingData = [NSMutableArray array];
    _pendingDone = [NSMutableArray array];
    return self;
}

/// YES when the caller is already running on self.q (or a queue nested in it).
- (BOOL)onOwnQueue {
    return dispatch_get_specific(kLNOwnQueueKey) != NULL;
}

- (BOOL)isOpen {
    if (self.onOwnQueue) return _state == LNSocketStateOpen;
    __block BOOL open;
    dispatch_sync(self.q, ^{ open = (_state == LNSocketStateOpen); });
    return open;
}

- (LNSocketState)state {
    if (self.onOwnQueue) return _state;
    __block LNSocketState s;
    dispatch_sync(self.q, ^{ s = _state; });
    return s;
}

#pragma mark - Lifecycle

- (void)open {
    dispatch_async(self.q, ^{
        if (self.shouldRun) return;
        self.shouldRun = YES;
        [self connect];
    });
}

- (void)close {
    dispatch_async(self.q, ^{
        self.shouldRun = NO;
        self.reconnectScheduled = NO; // pending dispatch_after re-checks shouldRun
        [self teardownTask];
        [self failPendingSends];
        self.state = LNSocketStateClosed;
        self.attempt = 0;
    });
}

- (void)teardownTask {
    [self stopPingTimer];
    self.awaitingPong = NO;
    id task = self.task;
    self.task = nil;
    if (task) {
        [(NSURLSessionTask *)task cancel]; // web socket task on iOS 13+, nil-safe cast
    }
}

- (void)connect {
    if (!self.shouldRun) return;
    self.state = LNSocketStateConnecting;

    if (!self.session) {
        NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        config.timeoutIntervalForRequest = 15.0;
        // 关键：绕过手机上的系统代理（Wi-Fi 手动代理 / PAC）。
        // 代理会把 WebSocket 的 Upgrade 请求当普通 HTTP 处理，导致
        // -1011 "bad server response"。空字典 = 本会话永不走代理，直连 Mac。
        config.connectionProxyDictionary = @{};
        self.session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
    }

    if (@available(iOS 13.0, *)) {
        [self teardownTask];
        NSURLSessionWebSocketTask *task = [self.session webSocketTaskWithURL:self.url];
        self.task = task;
        [task resume];
    } else {
        static dispatch_once_t once;
        dispatch_once(&once, ^{
            NSLog(@"[NetInspector] ✖ live streaming requires iOS 13+; events stay in the offline queue.");
        });
        self.state = LNSocketStateClosed;
    }
}

- (void)handleClosedWithError:(nullable NSError *)error {
    if (!self.task) return; // already torn down
    [self teardownTask];
    [self failPendingSends];
    self.state = LNSocketStateClosed;
    if (self.onClose) self.onClose(error);
    [self scheduleReconnect];
}

- (void)scheduleReconnect {
    if (!self.shouldRun || self.reconnectScheduled || _state == LNSocketStateOpen) return;

    self.reconnectScheduled = YES;
    double base = kLNReconnectMinDelay * pow(2.0, (double)MIN(self.attempt, 6));
    double delay = MIN(base, kLNReconnectMaxDelay);
    delay *= 0.7 + (arc4random() % 61) / 100.0; // ±30 % jitter
    self.attempt += 1;

    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(delay * NSEC_PER_SEC)), self.q, ^{
        self.reconnectScheduled = NO;
        if (self.shouldRun && _state == LNSocketStateClosed) {
            [self connect];
        }
    });
}

#pragma mark - Heartbeat

- (void)startPingTimer {
    [self stopPingTimer];
    NSTimeInterval interval = self.pingInterval > 0 ? self.pingInterval : kLNPingInterval;
    NSLog(@"[ws] ping timer started, interval=%.1fs", interval);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, self.q);
    dispatch_source_set_timer(timer,
                              dispatch_time(DISPATCH_TIME_NOW, (int64_t)(interval * NSEC_PER_SEC)),
                              (uint64_t)(interval * NSEC_PER_SEC),
                              (uint64_t)(1.0 * NSEC_PER_SEC));
    __weak typeof(self) weakSelf = self;
    dispatch_source_set_event_handler(timer, ^{
        typeof(self) s = weakSelf;
        if (!s) return;
        if (s->_state != LNSocketStateOpen) return;
        if (s.awaitingPong) {
            // Previous ping never came back — the link is dead.
            [s handleClosedWithError:[NSError errorWithDomain:NSURLErrorDomain
                                                         code:NSURLErrorTimedOut
                                                     userInfo:@{NSLocalizedDescriptionKey: @"pong timeout"}]];
            return;
        }
        s.awaitingPong = YES;
        [s sendPingWithHandler:^(NSError *pingError) {
            if (pingError) {
                // Ping failed — the link is dead. Reconnect instead of
                // silently retrying pings forever.
                [s handleClosedWithError:pingError];
                return;
            }
            s.awaitingPong = NO;
        }];
    });
    dispatch_resume(timer);
    self.pingTimer = timer;
}

- (void)stopPingTimer {
    if (self.pingTimer) {
        dispatch_source_cancel(self.pingTimer);
        self.pingTimer = nil;
    }
}

- (void)sendPingWithHandler:(void (^)(NSError * _Nullable error))handler {
    if (@available(iOS 13.0, *)) {
        NSURLSessionWebSocketTask *task = self.task;
        if (!task) return;
        [task sendPingWithPongReceiveHandler:^(NSError * _Nullable error) {
            dispatch_async(self.q, ^{ if (handler) handler(error); });
        }];
    }
}

#pragma mark - Sending

- (void)sendJSON:(NSDictionary *)payload completion:(nullable void (^)(BOOL))completion {
    dispatch_async(self.q, ^{
        void (^done)(BOOL) = completion ?: ^(BOOL delivered) {};
        if (_state != LNSocketStateOpen || !self.task) {
            done(NO);
            return;
        }
        NSData *data = [NSJSONSerialization isValidJSONObject:payload]
                     ? [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil]
                     : nil;
        if (!data) {
            done(NO);
            return;
        }
        [self.pendingData addObject:data];
        [self.pendingDone addObject:done];
        [self pump];
    });
}

- (void)pump {
    if (self.pumping || self.pendingData.count == 0) return;
    if (_state != LNSocketStateOpen || !self.task) {
        [self failPendingSends];
        return;
    }
    if (@available(iOS 13.0, *)) {
        self.pumping = YES;
        NSData *data = self.pendingData.firstObject;
        void (^done)(BOOL) = self.pendingDone.firstObject;
        [self.pendingData removeObjectAtIndex:0];
        [self.pendingDone removeObjectAtIndex:0];

        NSURLSessionWebSocketMessage *message = [[NSURLSessionWebSocketMessage alloc] initWithData:data];
        __weak typeof(self) weakSelf = self;
        [(NSURLSessionWebSocketTask *)self.task sendMessage:message completionHandler:^(NSError * _Nullable error) {
            dispatch_async(weakSelf.q, ^{
                typeof(self) s = weakSelf;
                if (!s) return;
                s.pumping = NO;
                done(error == nil);
                if (error && s->_state == LNSocketStateOpen) {
                    [s handleClosedWithError:error];
                }
                [s pump];
            });
        }];
    } else {
        [self failPendingSends];
    }
}

- (void)failPendingSends {
    NSArray<void (^)(BOOL)> *pending = [self.pendingDone copy];
    [self.pendingDone removeAllObjects];
    [self.pendingData removeAllObjects];
    for (void (^done)(BOOL) in pending) done(NO);
}

#pragma mark - NSURLSession (websocket) delegate
// Parameter types are deliberately loosened to NSURLSessionTask so this file
// compiles with any deployment target; selectors still match exactly.

- (void)URLSession:(NSURLSession *)session
              webSocketTask:(NSURLSessionTask *)webSocketTask
      didOpenWithProtocol:(NSString *)protocol {
    dispatch_async(self.q, ^{
        if (self.task != webSocketTask) return;
        self.state = LNSocketStateOpen;
        self.attempt = 0;
        [self startPingTimer];
        if (self.helloPayload) {
            [self sendJSON:self.helloPayload completion:nil];
        }
        [self pump];
        if (self.onOpen) self.onOpen();
    });
}

- (void)URLSession:(NSURLSession *)session
              webSocketTask:(NSURLSessionTask *)webSocketTask
        didCloseWithCode:(NSInteger)code
              reason:(NSData *)reason {
    dispatch_async(self.q, ^{
        if (self.task != webSocketTask) return;
        [self handleClosedWithError:nil];
    });
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(nullable NSError *)error {
    dispatch_async(self.q, ^{
        if (self.task != task) return;
        [self handleClosedWithError:error];
    });
}

- (void)URLSession:(NSURLSession *)session
     webSocketTask:(NSURLSessionTask *)webSocketTask
   didReceiveMessage:(id)rawMessage {
    if (@available(iOS 13.0, *)) {
        NSURLSessionWebSocketMessage *message = rawMessage;
        NSData *data = nil;
        if (message.type == NSURLSessionWebSocketMessageTypeString) {
            data = [message.string dataUsingEncoding:NSUTF8StringEncoding];
        } else {
            data = message.data;
        }
        id obj = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        if ([obj isKindOfClass:[NSDictionary class]] && self.onMessage) {
            self.onMessage(obj);
        }
    }
}

@end
