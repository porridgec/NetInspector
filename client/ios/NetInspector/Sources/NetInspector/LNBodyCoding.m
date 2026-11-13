//
//  LNBodyCoding.m
//  NetInspector
//

#import "LNBodyCoding.h"

static NSString *LNPlainUTF8String(NSData *data);

@implementation LNBufferedBody
@end

@implementation LNBodyCoding

+ (LNBufferedBody *)bufferBodyStream:(NSInputStream *)stream
                     maxInMemoryBytes:(NSUInteger)maxInMemoryBytes {
    LNBufferedBody *result = [[LNBufferedBody alloc] init];
    if (!stream) return result;

    NSMutableData *memory = [NSMutableData data];
    NSFileHandle *spill = nil;
    NSString *spillPath = nil;
    unsigned long long total = 0;
    uint8_t chunk[64 * 1024];

    [stream open];
    @try {
        while (YES) {
            NSInteger n = [stream read:chunk maxLength:sizeof(chunk)];
            if (n <= 0) break; // EOF or stream error (upload would fail anyway)
            total += (unsigned long long)n;

            if (spill) {
                [spill writeData:[NSData dataWithBytes:chunk length:(NSUInteger)n]];
            } else {
                [memory appendBytes:chunk length:(NSUInteger)n];
                if (maxInMemoryBytes > 0 && memory.length > maxInMemoryBytes) {
                    // Threshold exceeded — spill everything to a temp file so
                    // we never truncate a real upload just to record it.
                    spillPath = [self newSpillPath];
                    if ([[NSFileManager defaultManager] createFileAtPath:spillPath
                                                                contents:nil
                                                              attributes:nil]) {
                        spill = [NSFileHandle fileHandleForWritingAtPath:spillPath];
                        if (spill) [spill writeData:[NSData dataWithData:memory]];
                    }
                    if (!spill) {
                        // Temp file unavailable — keep buffering in memory as a
                        // correctness-preserving fallback.
                        spillPath = nil;
                    }
                }
            }
        }
    } @finally {
        [stream close];
        [spill closeFile];
    }

    result.totalSize = total;
    if (spillPath.length > 0) {
        result.tempPath = spillPath;
        result.prefix = [memory copy]; // bytes up to the spill point
    } else if (total > 0) {
        result.data = [memory copy];
        result.prefix = result.data;
    }
    return result;
}

+ (NSString *)newSpillPath {
    NSString *name = [NSString stringWithFormat:@"netinspector-body-%@.tmp", [NSUUID UUID].UUIDString];
    return [NSTemporaryDirectory() stringByAppendingPathComponent:name];
}

+ (NSDictionary<NSString *, id> *)payloadForData:(nullable NSData *)data
                                    originalSize:(unsigned long long)originalSize
                                          limit:(NSUInteger)limit {
    if (originalSize == 0 || data.length == 0) {
        return @{ @"encoding": @"none",
                  @"body": @"",
                  @"size": @(0),
                  @"truncated": @NO };
    }

    BOOL truncated = NO;
    NSData *capture = data;
    if (limit > 0 && data.length > limit) {
        capture = [data subdataWithRange:NSMakeRange(0, limit)];
        truncated = YES;
    }
    if (originalSize > capture.length) truncated = YES;

    NSString *text = LNPlainUTF8String(capture);
    if (text) {
        return @{ @"encoding": @"text",
                  @"body": text,
                  @"size": @(originalSize),
                  @"truncated": @(truncated) };
    }
    return @{ @"encoding": @"base64",
              @"body": [capture base64EncodedStringWithOptions:0],
              @"size": @(originalSize),
              @"truncated": @(truncated) };
}

@end

static NSString *LNPlainUTF8String(NSData *data) {
    if (data.length == 0) return @"";
    NSString *string = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!string) return nil;

    // Reject strings that "decode" but contain unprintable control characters
    // (allowing \t \n \r) — those are almost certainly binary.
    static NSCharacterSet *bad = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSMutableCharacterSet *cs = [[NSCharacterSet controlCharacterSet] mutableCopy];
        [cs removeCharactersInString:@"\t\n\r"];
        bad = cs;
    });
    if ([string rangeOfCharacterFromSet:bad].location != NSNotFound) return nil;

    return string;
}
