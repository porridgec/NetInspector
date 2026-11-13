//
//  LNNetInspector.h
//  NetInspector
//
//  Public facade of the LAN network inspector.
//
//  链式初始化（Swift）：
//      import NetInspector
//      LNNetInspector.shared()
//          .host("192.168.1.8")
//          .port(9090)
//          .authToken("my-secret")     // 服务端设置了 TOKEN 时必填
//          .start()
//
//  链式初始化（Objective-C）：
//      [[[[LNNetInspector shared] host:@"192.168.1.8"] port:9090] start];
//
//  Captures URLSession / NSURLConnection traffic (including Alamofire,
//  AFNetworking, Swift Packages and other libraries built on top of the
//  URL Loading System) and streams it live to the NetInspector dashboard.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface LNNetInspector : NSObject

- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;

+ (instancetype)shared;

#pragma mark - 链式配置（必须在 -start 之前调用）

/// Mac 服务端 IP，如 @"192.168.1.8"。返回 self 供链式调用。
- (instancetype)host:(nullable NSString *)host;

/// Mac 服务端端口，默认 9090。
- (instancetype)port:(NSUInteger)port;

/// 可选访问令牌，需与服务端 TOKEN 环境变量一致。
/// ws 走 ?token=，HTTP 回退通道走 x-ni-token 头。
- (instancetype)authToken:(nullable NSString *)authToken;

/// 不抓取的域名（精确匹配，或 @"*.example.com" 通配）。
/// 服务端自身地址始终会被过滤（防反馈循环）。
- (instancetype)ignoredHosts:(NSArray<NSString *> *)ignoredHosts;

/// 单个 request/response body 的展示保留上限（字节）。默认 256 KiB。
- (instancetype)maxBodyCaptureBytes:(NSUInteger)bytes;

/// 流式 body（multipart/upload）在内存中缓冲的上限（字节）。默认 32 MiB，
/// 超过后自动落盘转发，不影响真实上传。
- (instancetype)maxStreamBodyBytes:(NSUInteger)bytes;

/// 断网时磁盘离线队列容量（条）。默认 500。
- (instancetype)offlineQueueCapacity:(NSUInteger)capacity;

#pragma mark - 连接状态（属性形式：只读快照 / 变化回调）

/// 连接状态变化回调（WebSocket 打开/关闭时触发，主线程调用）。
/// reason 为关闭原因（nil = 正常/本地关闭）。
@property (nonatomic, copy, nullable) void (^onConnectionChange)(BOOL connected, NSString * _Nullable reason);

/// 当前 WebSocket 连接状态（只读快照；实时变化请用 onConnectionChange）
@property (nonatomic, readonly) BOOL wsConnected;

#pragma mark - Lifecycle

/// 启动拦截 + WebSocket 流式传输。幂等。
- (void)start;

/// 停止拦截并关闭连接，未发送事件保留在磁盘队列。
- (void)stop;

- (BOOL)isRunning;

@end

NS_ASSUME_NONNULL_END
