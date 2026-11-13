//
//  LNNetInspector+Internal.h
//  NetInspector
//
//  Internal surface used by LNURLProtocol / LNURLSessionHook.
//  Not part of the public API.
//

#import "LNNetInspector.h"

NS_ASSUME_NONNULL_BEGIN

@interface LNNetInspector (Internal)

@property (nonatomic, readonly, getter=isEnabled) BOOL enabled;
@property (nonatomic, readonly, copy) NSString *clientId;
@property (nonatomic, readonly, copy) NSString *deviceLabel;

/// 配置值（内部拦截器读取；对 Swift 不暴露，公开 API 只有链式方法）
@property (nonatomic, readonly) NSUInteger maxBodyCaptureBytes;
@property (nonatomic, readonly) NSUInteger maxStreamBodyBytes;

/// YES if this URL should be captured (filters ignored hosts + the server itself).
- (BOOL)shouldCaptureURL:(nullable NSURL *)url;

/// Serializes, tags and delivers an event (socket or offline queue). Thread-safe.
- (void)recordEvent:(NSDictionary<NSString *, id> *)event;

@end

NS_ASSUME_NONNULL_END
