//
//  LNOfflineQueue.h
//  NetInspector
//
//  Disk-backed FIFO of unsent events (survives app restarts).
//  Not thread-safe by itself — LNNetInspector serializes all access.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface LNOfflineQueue : NSObject

- (instancetype)initWithDirectory:(NSString *)directory
                         capacity:(NSUInteger)capacity
                         maxBytes:(NSUInteger)maxBytes;

@property (nonatomic, readonly) NSUInteger count;
@property (nonatomic, readonly) unsigned long long totalBytes;

/// Appends an event; drops the oldest files when capacity/byte limits are hit.
- (void)enqueue:(NSDictionary<NSString *, id> *)payload;

/// Oldest-first batch. Each returned dict gains a @"_file" key for removal.
- (NSArray<NSDictionary<NSString *, id> *> *)peekBatch:(NSUInteger)n;

- (void)removeFile:(NSString *)fileName;
- (void)removeAll;

@end

NS_ASSUME_NONNULL_END
