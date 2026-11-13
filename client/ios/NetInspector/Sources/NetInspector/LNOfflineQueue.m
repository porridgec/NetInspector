//
//  LNOfflineQueue.m
//  NetInspector
//

#import "LNOfflineQueue.h"

@interface LNOfflineQueue ()
@property (nonatomic, copy) NSString *dir;
@property (nonatomic, strong) NSMutableArray<NSString *> *files; // oldest first (name-sorted)
@property (nonatomic, assign) unsigned long long bytes;
@property (nonatomic, assign) NSUInteger capacity;
@property (nonatomic, assign) unsigned long long maxBytes;
@property (nonatomic, strong) NSFileManager *fm;
@property (nonatomic, assign) NSUInteger counter;
@end

@implementation LNOfflineQueue

- (instancetype)initWithDirectory:(NSString *)directory
                         capacity:(NSUInteger)capacity
                         maxBytes:(NSUInteger)maxBytes {
    self = [super init];
    if (!self) return nil;
    _dir = [directory copy];
    _capacity = capacity > 0 ? capacity : 500;
    _maxBytes = maxBytes > 0 ? maxBytes : (20 * 1024 * 1024);
    _fm = [NSFileManager defaultManager];
    _files = [NSMutableArray array];

    [_fm createDirectoryAtPath:_dir withIntermediateDirectories:YES attributes:nil error:nil];
    [self reloadExisting];
    return self;
}

- (void)reloadExisting {
    NSArray<NSString *> *names = [[_fm contentsOfDirectoryAtPath:_dir error:nil]
        sortedArrayUsingSelector:@selector(compare:)];
    for (NSString *name in names) {
        if (![name.pathExtension isEqualToString:@"json"]) continue;
        unsigned long long size = [self fileSizeOf:name];
        if (size == 0) {
            [_fm removeItemAtPath:[self pathOf:name] error:nil];
            continue;
        }
        [_files addObject:name];
        _bytes += size;
    }
    _counter = _files.count;
    [self trim];
}

#pragma mark - API

- (NSUInteger)count {
    return self.files.count;
}

- (unsigned long long)totalBytes {
    return self.bytes;
}

- (void)enqueue:(NSDictionary<NSString *, id> *)payload {
    if (payload.count == 0) return;
    NSData *data = [NSJSONSerialization isValidJSONObject:payload]
                 ? [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil]
                 : nil;
    if (data.length == 0) return;

    self.counter += 1;
    NSString *name = [NSString stringWithFormat:@"%013llu-%06u.json",
                      (unsigned long long)llround([[NSDate date] timeIntervalSince1970] * 1000.0),
                      (uint32_t)self.counter];

    if (![data writeToFile:[self pathOf:name] options:NSAtomicWrite error:nil]) return;

    [self.files addObject:name];
    self.bytes += data.length;
    [self trim];
}

- (NSArray<NSDictionary<NSString *, id> *> *)peekBatch:(NSUInteger)n {
    NSMutableArray<NSDictionary *> *batch = [NSMutableArray arrayWithCapacity:MIN(n, self.files.count)];
    for (NSString *name in [self.files copy]) {
        if (batch.count >= n) break;
        NSData *data = [NSData dataWithContentsOfFile:[self pathOf:name]];
        if (!data) continue;
        id obj = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (![obj isKindOfClass:[NSDictionary class]]) continue;
        NSMutableDictionary *dict = [obj mutableCopy];
        dict[@"_file"] = name;
        [batch addObject:dict];
    }
    return batch;
}

- (void)removeFile:(NSString *)fileName {
    if (fileName.length == 0) return;
    unsigned long long size = [self fileSizeOf:fileName];
    if ([self.fm removeItemAtPath:[self pathOf:fileName] error:nil]) {
        [self.files removeObject:fileName];
        self.bytes = self.bytes > size ? self.bytes - size : 0;
    }
}

- (void)removeAll {
    for (NSString *name in [self.files copy]) {
        [self.fm removeItemAtPath:[self pathOf:name] error:nil];
    }
    [self.files removeAllObjects];
    self.bytes = 0;
}

#pragma mark - Private

- (NSString *)pathOf:(NSString *)name {
    return [self.dir stringByAppendingPathComponent:name];
}

- (unsigned long long)fileSizeOf:(NSString *)name {
    NSDictionary *attrs = [self.fm attributesOfItemAtPath:[self pathOf:name] error:nil];
    return attrs.fileSize;
}

- (void)trim {
    while (self.files.count > self.capacity) {
        [self removeOldest];
    }
    while (self.bytes > self.maxBytes && self.files.count > 1) {
        [self removeOldest];
    }
}

- (void)removeOldest {
    NSString *oldest = self.files.firstObject;
    if (oldest) [self removeFile:oldest];
}

@end
