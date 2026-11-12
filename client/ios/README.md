# NetInspector — iOS 客户端

零依赖的 Objective-C 模块（Swift / Objective-C 项目通用），把 App 的网络请求实时镜像到 Mac 端 Dashboard。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `NetInspector.h` | 伞头文件（引入全部公开头） |
| `LNNetInspector.h/.m` | 公开门面：配置、启停、离线冲刷 |
| `LNNetInspector+Internal.h` | 内部接口（拦截器 ↔ 门面通信） |
| `LNURLProtocol.h/.m` | 录制型 `NSURLProtocol`：捕获请求/响应/重定向/错误 |
| `LNURLSessionHook.h/.m` | Swizzle `NSURLSessionConfiguration`，让第三方库也被拦截 |
| `LNWebSocketClient.h/.m` | WebSocket 客户端：指数退避重连 + 心跳 |
| `LNOfflineQueue.h/.m` | 磁盘离线队列（Caches 目录，断网可存活重启） |
| `LNBodyCoding.h/.m` | Body 安全编码 + 流式 body 缓冲（超限自动落盘，multipart/大上传不受影响） |

## 系统要求

- 实时流式传输需要 **iOS 13+**（`NSURLSessionWebSocketTask`）；更低版本自动降级为仅离线排队，编译不受影响（deployment target 任意）。
- 仅在 DEBUG 构建启用（建议），见根目录 `README.md` 的接入指南。

## 快速使用

**Objective-C**

```objc
#import "NetInspector.h"

[[LNNetInspector shared] startWithHost:@"192.168.1.8" port:9090];
```

**Swift**（通过桥接头 `#import "NetInspector.h"`）

```swift
LNNetInspector.shared().host = "192.168.1.8"
LNNetInspector.shared().start()
```

完整的接入步骤（bridging header、ATS、AppDelegate 初始化位置、常见问题）见项目根目录 `README.md`。
