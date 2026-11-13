//
//  LNBodyCoding.h
//  NetInspector
//
//  Safe body serialization helpers.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Result of buffering an HTTPBodyStream.
/// - Small bodies: everything in `data` (whole body in memory).
/// - Bodies larger than maxInMemoryBytes: written to a temp file (`tempPath`),
///   and `prefix` holds the first bytes for display capture. The temp file
///   must be deleted by the owner when the request finishes.
@interface LNBufferedBody : NSObject

@property (nonatomic, strong, nullable) NSData *data;        // whole body when ≤ maxInMemoryBytes
@property (nonatomic, copy, nullable) NSString *tempPath;    // spill file when larger
@property (nonatomic, strong, nullable) NSData *prefix;      // first bytes, for display
@property (nonatomic, assign) unsigned long long totalSize;  // true body size

@end

@interface LNBodyCoding : NSObject

/**
 * Fully drains an HTTPBodyStream (e.g. multipart uploads). Bodies up to
 * maxInMemoryBytes stay in memory; larger ones spill to a temp file so the
 * real upload is forwarded byte-complete — capture limits never truncate
 * actual traffic.
 */
+ (LNBufferedBody *)bufferBodyStream:(NSInputStream *)stream
                     maxInMemoryBytes:(NSUInteger)maxInMemoryBytes;

/**
 * Turns a body into a JSON-safe payload:
 *   { encoding: "text"|"base64"|"none",
 *     body: NSString,
 *     size: NSNumber (original byte count),
 *     truncated: NSNumber (BOOL) }
 *
 * Binary data (invalid UTF-8 or unprintable) is base64-encoded so the
 * dashboard can hex-dump / preview / download it.
 */
+ (NSDictionary<NSString *, id> *)payloadForData:(nullable NSData *)data
                                    originalSize:(unsigned long long)originalSize
                                          limit:(NSUInteger)limit;

@end

NS_ASSUME_NONNULL_END
