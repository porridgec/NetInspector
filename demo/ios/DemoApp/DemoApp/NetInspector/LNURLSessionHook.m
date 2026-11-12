//
//  LNURLSessionHook.m
//  NetInspector
//

#import "LNURLSessionHook.h"
#import "LNURLProtocol.h"
#import "LNNetInspector.h"
#import "LNNetInspector+Internal.h"
#import <objc/runtime.h>

typedef NSURLSessionConfiguration *(*LNConfigFactoryIMP)(id self, SEL _cmd);

static LNConfigFactoryIMP LN_origDefaultFactory = NULL;
static LNConfigFactoryIMP LN_origEphemeralFactory = NULL;

static NSURLSessionConfiguration *LNInject(NSURLSessionConfiguration *config) {
    if (!config) return nil;
    @try {
        if (![LNNetInspector shared].enabled) return config;

        NSArray *protocolClasses = config.protocolClasses;
        if (!protocolClasses) {
            // nil = "use the global registry", where we also registered via
            // +[NSURLProtocol registerClass:]. Nothing to inject.
            return config;
        }
        for (id cls in protocolClasses) {
            if (cls == [LNURLProtocol class]) return config;
        }
        NSMutableArray *mutable = [protocolClasses mutableCopy];
        [mutable insertObject:[LNURLProtocol class] atIndex:0];
        config.protocolClasses = mutable;
    } @catch (NSException *exception) {
        // Never break the host app.
    }
    return config;
}

static NSURLSessionConfiguration *LNHookedDefault(id self, SEL _cmd) {
    return LNInject(LN_origDefaultFactory(self, _cmd));
}

static NSURLSessionConfiguration *LNHookedEphemeral(id self, SEL _cmd) {
    return LNInject(LN_origEphemeralFactory(self, _cmd));
}

static void LNSwapClassMethod(Class cls, SEL selector, IMP newIMP, LNConfigFactoryIMP *original) {
    Method method = class_getClassMethod(cls, selector);
    if (!method || !original) return;
    *original = (LNConfigFactoryIMP)method_setImplementation(method, newIMP);
}

@implementation LNURLSessionHook

+ (void)load {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        Class cls = objc_getClass("NSURLSessionConfiguration");
        if (!cls) return;
        LNSwapClassMethod(cls, @selector(defaultSessionConfiguration),
                          (IMP)LNHookedDefault, &LN_origDefaultFactory);
        LNSwapClassMethod(cls, @selector(ephemeralSessionConfiguration),
                          (IMP)LNHookedEphemeral, &LN_origEphemeralFactory);
    });
}

+ (void)install {
    // Hooks were installed in +load; this exists for explicitness at -start.
}

@end
