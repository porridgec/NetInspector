//
//  LNURLProtocol.h
//  NetInspector
//
//  Recording URLProtocol — mirrors app traffic into the NetInspector pipeline.
//  Do not instantiate directly; registered automatically by LNNetInspector.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface LNURLProtocol : NSURLProtocol
@end

NS_ASSUME_NONNULL_END
