//
//  LNURLSessionHook.h
//  NetInspector
//
//  Swizzles +[NSURLSessionConfiguration defaultSessionConfiguration] and
//  +[ephemeralSessionConfiguration] so that every session created by the app
//  (Alamofire, AFNetworking, SDWebImage, raw URLSession, …) consults
//  LNURLProtocol. Installed from +load; takes effect only while the
//  inspector is running, and never alters normal loading behaviour.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface LNURLSessionHook : NSObject

/// Installed automatically from +load. Idempotent; safe to call for clarity.
+ (void)install;

@end

NS_ASSUME_NONNULL_END
