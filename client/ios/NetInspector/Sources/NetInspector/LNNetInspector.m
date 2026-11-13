//
//  LNNetInspector.m
//  NetInspector
//

#import "LNNetInspector.h"
#import "LNNetInspector+Internal.h"
#import "LNURLProtocol.h"
#import "LNURLSessionHook.h"
#import "LNWebSocketClient.h"
#import "LNOfflineQueue.h"

#import <UIKit/UIKit.h>
#import <sys/utsname.h>

static NSString * const kLNClientIdDefaultsKey = @"netinspector.client-id";
static NSUInteger const kLNMaxInflightSends = 256;
static NSUInteger const kLNDrainBatchSize = 32;

@interface LNNetInspector ()
@property (nonatomic, strong) LNWebSocketClient *wsClient;
@property (nonatomic, strong) LNOfflineQueue *offlineQueue;
@property (nonatomic, strong) dispatch_queue_t internalQueue;
// getter 名必须与 LNNetInspector+Internal.h 的声明一致（isEnabled），
// 否则外部调用 `.enabled` 生成的 selector 无实现 → 运行时崩溃。
@property (nonatomic, assign, getter=isEnabled) BOOL enabled;
@property (nonatomic, assign) NSInteger inflightSends;
@property (nonatomic, assign) BOOL draining;
@property (nonatomic, assign) NSInteger handshakeFailures;
@property (nonatomic, assign) BOOL httpFallbackActive;   // POST /log 回退通道
@property (nonatomic, assign) BOOL wsConnected;           // 供 onConnectionChange 去重
@property (nonatomic, strong, nullable) NSURLSession *httpSession;
@property (nonatomic, copy) NSString *clientId;
@property (nonatomic, copy) NSString *deviceLabel;
@property (nonatomic, strong) NSDictionary *cachedClientInfo;
@end

static NSInteger const kLNWsFailuresBeforeFallback = 2;

@implementation LNNetInspector

#pragma mark - Singleton

+ (instancetype)shared {
    static LNNetInspector *instance = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        instance = [[LNNetInspector alloc] initInternal];
    });
    return instance;
}

- (instancetype)initInternal {
    self = [super init];
    if (!self) return nil;

    _port = 9090;
    _maxBodyCaptureBytes = 256 * 1024;
    _maxStreamBodyBytes = 32 * 1024 * 1024;
    _offlineQueueCapacity = 500;
    _ignoredHosts = @[];
    _internalQueue = dispatch_queue_create("netinspector.core", DISPATCH_QUEUE_SERIAL);

    NSString *clientId = [[NSUserDefaults standardUserDefaults] stringForKey:kLNClientIdDefaultsKey];
    if (clientId.length == 0) {
        clientId = [[NSUUID UUID] UUIDString];
        [[NSUserDefaults standardUserDefaults] setObject:clientId forKey:kLNClientIdDefaultsKey];
    }
    _clientId = clientId;
    _deviceLabel = [NSString stringWithFormat:@"%@ · %@",
                    [UIDevice currentDevice].name ?: @"iOS",
                    [self appLabel]];
    _cachedClientInfo = [self buildClientInfo];

    _offlineQueue = [[LNOfflineQueue alloc] initWithDirectory:[self defaultQueueDirectory]
                                                     capacity:_offlineQueueCapacity
                                                     maxBytes:20 * 1024 * 1024];
    return self;
}

- (NSString *)defaultQueueDirectory {
    NSArray<NSString *> *caches = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
    NSString *base = caches.firstObject ?: NSTemporaryDirectory();
    return [base stringByAppendingPathComponent:@"netinspector.queue"];
}

#pragma mark - Device info

- (NSString *)appLabel {
    NSDictionary *info = [NSBundle mainBundle].infoDictionary;
    NSString *name = info[@"CFBundleName"] ?: info[@"CFBundleExecutable"] ?: @"App";
    NSString *version = info[@"CFBundleShortVersionString"] ?: @"0";
    NSString *build = info[@"CFBundleVersion"] ?: @"0";
    return [NSString stringWithFormat:@"%@ %@ (%@)", name, version, build];
}

- (NSString *)machineModel {
    struct utsname systemInfo;
    if (uname(&systemInfo) != 0) return nil;
    return [NSString stringWithCString:systemInfo.machine encoding:NSUTF8StringEncoding];
}

- (NSDictionary *)clientInfo {
    return _cachedClientInfo ?: (_cachedClientInfo = [self buildClientInfo]);
}

- (NSDictionary *)buildClientInfo {
    UIDevice *device = [UIDevice currentDevice];
    return @{
        @"id": self.clientId,
        @"name": device.name ?: @"iOS device",
        @"model": [self machineModel] ?: @"iOS",
        @"system": [NSString stringWithFormat:@"%@ %@",
                    device.systemName ?: @"iOS",
                    device.systemVersion ?: @""],

        @"app": [self appLabel],
    };
}

#pragma mark - Lifecycle

- (void)start {
    if (self.enabled) return;
    self.enabled = YES;

    // Global registry: covers sessions with nil protocolClasses
    // (e.g. +[NSURLSession sharedSession]).
    [NSURLProtocol registerClass:[LNURLProtocol class]];
    // +load already swizzled config creation; keep for explicitness.
    [LNURLSessionHook install];

    if (self.host.length == 0) {
        NSLog(@"[NetInspector] ⚠ host not set — set .host before -start, or use -startWithHost:port:. "
              @"Events will only accumulate in the offline queue.");
        return;
    }
    [self connectWebSocket];
}

- (void)startWithHost:(NSString *)host port:(NSUInteger)port {
    self.host = host;
    self.port = port;
    [self start];
}

- (void)stop {
    self.enabled = NO;
    [NSURLProtocol unregisterClass:[LNURLProtocol class]];
    [self.wsClient close];
    dispatch_async(self.internalQueue, ^{
        self.handshakeFailures = 0;
        self.httpFallbackActive = NO;
    });
}

- (BOOL)isRunning {
    return self.enabled;
}

- (void)connectWebSocket {
    if (self.host.length == 0 || self.port == 0) return;

    [self.wsClient close];
    self.wsClient = nil;

    NSURLComponents *components = [NSURLComponents new];
    components.scheme = @"ws";
    components.host = self.host;
    components.port = @(self.port);
    components.path = @"/log";
    if (self.authToken.length > 0) {
        components.queryItems = @[[NSURLQueryItem queryItemWithName:@"token" value:self.authToken]];
    }
    NSURL *url = [components URL];
    if (!url) {
        NSLog(@"[NetInspector] ⚠ invalid server URL (host=%@ port=%lu)", self.host, (unsigned long)self.port);
        return;
    }

    LNWebSocketClient *client = [[LNWebSocketClient alloc] initWithURL:url];
    client.helloPayload = @{@"type": @"hello", @"client": [self clientInfo]};

    __weak typeof(self) weakSelf = self;
    client.onOpen = ^{
        [weakSelf markConnected];
        [weakSelf notifyConnectionChange:YES reason:nil];
        [weakSelf drainOfflineQueue];
    };
    client.onMessage = ^(NSDictionary *message) {
        [weakSelf handleServerMessage:message];
    };
    client.onClose = ^(NSError *error) {
        [weakSelf noteSocketFailure:error];
        [weakSelf notifyConnectionChange:NO reason:error.localizedDescription];
    };

    self.wsClient = client;
    [client open];
}

/// 连接状态变化 → 主线程回调（供 UI 展示）
- (void)notifyConnectionChange:(BOOL)connected reason:(NSString * _Nullable)reason {
    dispatch_async(self.internalQueue, ^{
        if (self.wsConnected == connected) return;
        self.wsConnected = connected;
        if (self.onConnectionChange) {
            dispatch_async(dispatch_get_main_queue(), ^{
                self.onConnectionChange(connected, reason);
            });
        }
    });
}

- (void)markConnected {
    dispatch_async(self.internalQueue, ^{
        self.handshakeFailures = 0;
        if (self.httpFallbackActive) {
            self.httpFallbackActive = NO;
            NSLog(@"[NetInspector] ✓ WebSocket 直连已恢复，停用 HTTP 回退通道");
        }
    });
}

- (void)noteSocketFailure:(NSError * _Nullable)error {
    dispatch_async(self.internalQueue, ^{
        if (!error) return;
        self.handshakeFailures += 1;

        if (error.code == NSURLErrorBadServerResponse && self.handshakeFailures <= 2) {
            // -1011: something answered with plain HTTP — most often a proxy on
            // the phone intercepting the WebSocket upgrade, or a wrong IP.
            NSLog(@"[NetInspector] ⚠ WebSocket handshake failed (%@) for ws://%@:%lu — "
                  @"对端返回了普通 HTTP 而非 WebSocket 升级。常见原因：\n"
                  "   ① 手机开了代理（本客户端已自动绕过系统代理直连；VPN 型代理请在其规则里把 Mac IP 设为 DIRECT）\n"
                  "   ② IP/端口不对 —— 以服务端启动横栏打印的地址为准\n"
                  "   ③ 服务未启动（cd server && npm start）",
                  error.localizedDescription, self.host, (unsigned long)self.port);
        } else if (self.handshakeFailures <= 2) {
            NSLog(@"[NetInspector] socket closed: %@ (retrying with backoff…)", error.localizedDescription);
        }

        // WebSocket 反复失败（典型：代理/防火墙拦 Upgrade）→ 切换 HTTP 回退通道。
        // 普通 HTTP POST 常能穿过只拦 WebSocket 的中间层。
        if (!self.httpFallbackActive && self.handshakeFailures >= kLNWsFailuresBeforeFallback) {
            self.httpFallbackActive = YES;
            NSLog(@"[NetInspector] ⇄ 启用 HTTP 回退通道 → http://%@:%lu/log", self.host, (unsigned long)self.port);
            [self httpSend:@{@"type": @"hello", @"client": [self clientInfo]} completion:nil];
            [self drainOfflineQueue];
        }
    });
}

#pragma mark - Internal (recording pipeline)

- (BOOL)shouldCaptureURL:(NSURL *)url {
    NSString *host = url.host.lowercaseString;
    if (host.length == 0) return NO;

    // Never capture our own connection to the dashboard (feedback loop).
    NSString *serverHost = self.host.lowercaseString;
    if (serverHost.length > 0 && [host isEqualToString:serverHost]) return NO;

    for (NSString *pattern in self.ignoredHosts) {
        NSString *rule = pattern.lowercaseString;
        if (rule.length == 0) continue;
        if ([rule hasPrefix:@"*."]) {
            NSString *suffix = [rule substringFromIndex:1]; // ".example.com"
            NSString *bare = [rule substringFromIndex:2];   // "example.com"
            if ([host hasSuffix:suffix] || [host isEqualToString:bare]) return NO;
        } else if ([host isEqualToString:rule]) {
            return NO;
        }
    }
    return YES;
}

- (void)recordEvent:(NSDictionary<NSString *, id> *)event {
    if (!self.enabled) return;

    dispatch_async(self.internalQueue, ^{
        NSMutableDictionary *tagged = [event mutableCopy] ?: [NSMutableDictionary new];
        tagged[@"clientId"] = self.clientId;
        tagged[@"clientName"] = self.deviceLabel;
        NSDictionary *payload = @{@"type": @"request", @"event": [tagged copy]};

        if (self.wsClient.isOpen && self.inflightSends < (NSInteger)kLNMaxInflightSends) {
            self.inflightSends += 1;
            __weak typeof(self) weakSelf = self;
            [self.wsClient sendJSON:payload completion:^(BOOL delivered) {
                dispatch_async(weakSelf.internalQueue, ^{
                    weakSelf.inflightSends -= 1;
                    if (!delivered) {
                        [weakSelf.offlineQueue enqueue:payload];
                    }
                });
            }];
        } else {
            [self.offlineQueue enqueue:payload];
            // HTTP 回退模式下立即冲刷（不等 ws 恢复）
            if (self.httpFallbackActive) {
                [self drainOfflineQueue];
            }
        }
    });
}

- (void)drainOfflineQueue {
    dispatch_async(self.internalQueue, ^{
        if (self.draining) return;
        BOOL viaWebSocket = self.wsClient.isOpen;
        if (!viaWebSocket && !self.httpFallbackActive) return;

        NSArray<NSDictionary *> *batch = [self.offlineQueue peekBatch:kLNDrainBatchSize];
        if (batch.count == 0) return;

        self.draining = YES;
        dispatch_group_t group = dispatch_group_create();
        for (NSDictionary *payload in batch) {
            NSString *file = payload[@"_file"];
            dispatch_group_enter(group);
            void (^deliver)(void (^)(BOOL)) = viaWebSocket
                ? ^(void (^done)(BOOL)) { [self.wsClient sendJSON:payload completion:done]; }
                : ^(void (^done)(BOOL)) { [self httpSend:payload completion:done]; };
            deliver(^(BOOL delivered) {
                dispatch_async(self.internalQueue, ^{
                    if (delivered && file.length > 0) {
                        [self.offlineQueue removeFile:file];
                    }
                    dispatch_group_leave(group);
                });
            });
        }
        dispatch_group_notify(group, self.internalQueue, ^{
            self.draining = NO;
            if (self.offlineQueue.count > 0 && (self.wsClient.isOpen || self.httpFallbackActive)) {
                [self drainOfflineQueue];
            }
        });
    });
}

#pragma mark - HTTP fallback transport (POST /log)

// 走系统默认代理设置：当代理只拦 WebSocket 升级时，普通 HTTP POST 仍可能穿过。
- (void)httpSend:(NSDictionary *)payload completion:(nullable void (^)(BOOL))completion {
    void (^done)(BOOL) = completion ?: ^(BOOL delivered) {};

    if (self.host.length == 0 || self.port == 0) { done(NO); return; }
    NSURLComponents *components = [NSURLComponents new];
    components.scheme = @"http";
    components.host = self.host;
    components.port = @(self.port);
    components.path = @"/log";

    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[components URL]
                                                             cachePolicy:NSURLRequestReloadIgnoringLocalCacheData
                                                         timeoutInterval:10.0];
    request.HTTPMethod = @"POST";
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    if (self.authToken.length > 0) {
        [request setValue:self.authToken forHTTPHeaderField:@"x-ni-token"];
    }
    request.HTTPBody = [NSJSONSerialization isValidJSONObject:payload]
                     ? [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil]
                     : nil;
    if (!request.HTTPBody) { done(NO); return; }

    [[[self httpSession] dataTaskWithRequest:request
                          completionHandler:^(NSData * _Nullable data, NSURLResponse * _Nullable response, NSError * _Nullable error) {
        BOOL ok = error == nil
               && [response isKindOfClass:[NSHTTPURLResponse class]]
               && ((NSHTTPURLResponse *)response).statusCode < 300;
        done(ok);
    }] resume];
}

- (NSURLSession *)httpSession {
    if (!_httpSession) {
        NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
        config.timeoutIntervalForRequest = 10.0;
        _httpSession = [NSURLSession sessionWithConfiguration:config];
    }
    return _httpSession;
}

- (void)handleServerMessage:(NSDictionary *)message {
    // Reserved for future server→client commands. Nothing to do yet.
    (void)message;
}

@end
