//
//  LNWebSocketClient.h
//  NetInspector
//
//  Minimal WebSocket client on NSURLSessionWebSocketTask (iOS 13+).
//  Exponential-backoff reconnect + heartbeat; on older systems it simply
//  stays closed (events keep accumulating in the offline queue).
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, LNSocketState) {
    LNSocketStateClosed = 0,
    LNSocketStateConnecting,
    LNSocketStateOpen,
};

@interface LNWebSocketClient : NSObject

- (instancetype)initWithURL:(NSURL *)url;

@property (nonatomic, readonly) LNSocketState state;
@property (nonatomic, readonly) BOOL isOpen;

/// Liveness ping interval in seconds. Default 20.
/// (An idle URLSessionWebSocketTask does NOT notice a dead peer on its own —
/// this heartbeat is what triggers reconnect on silent link loss.)
@property (nonatomic, assign) NSTimeInterval pingInterval;

/// Sent automatically as the first frame after every successful connect.
@property (nonatomic, copy, nullable) NSDictionary<NSString *, id> *helloPayload;

@property (nonatomic, copy, nullable) void (^onOpen)(void);
@property (nonatomic, copy, nullable) void (^onClose)(NSError * _Nullable error);
@property (nonatomic, copy, nullable) void (^onMessage)(NSDictionary<NSString *, id> *message);

- (void)open;
- (void)close;

/**
 * Sends immediately if connected; otherwise completion(NO) fires (synchronously
 * from an internal queue) and the caller decides how to persist the event.
 * Sends are serialized to preserve ordering.
 */
- (void)sendJSON:(NSDictionary *)payload
      completion:(nullable void (^)(BOOL delivered))completion;

@end

NS_ASSUME_NONNULL_END
