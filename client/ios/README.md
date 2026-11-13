# NetInspector — iOS 客户端

零依赖的 Objective-C 模块（Swift / Objective-C 项目通用），把 App 的网络请求实时镜像到 Mac 端 Dashboard。

## 文件清单（14 个文件）

| 文件 | 职责 |
| --- | --- |
| `NetInspector.h` | 伞头文件（引入全部公开头） |
| `LNNetInspector.h/.m` | 公开门面：配置、启停、令牌、连接状态、离线冲刷 |
| `LNNetInspector+Internal.h` | 内部接口（拦截器 ↔ 门面通信） |
| `LNURLProtocol.h/.m` | 录制型 `NSURLProtocol`：捕获请求/响应/重定向/错误 |
| `LNURLSessionHook.h/.m` | Swizzle `NSURLSessionConfiguration`：`+load` 时**无条件注入**（覆盖 SPM 包内早于 `-start` 创建的 session 单例），开关在 `canInitWithRequest:` |
| `LNWebSocketClient.h/.m` | WebSocket 客户端：指数退避重连 + 心跳 + 系统代理绕过 |
| `LNOfflineQueue.h/.m` | 磁盘离线队列（Caches 目录，断网可存活重启） |
| `LNBodyCoding.h/.m` | Body 安全编码 + 流式 body 缓冲（超限自动落盘，multipart/大上传不受影响） |

## 系统要求

- 实时流式传输需要 **iOS 13+**（`NSURLSessionWebSocketTask`）；更低版本自动降级为仅离线排队，编译不受影响（deployment target 任意）。
- 仅在 DEBUG 构建启用（建议），见根目录 `README.md` 的接入指南。

## 快速使用

**Objective-C**

```objc
#import "NetInspector.h"

LNNetInspector *inspector = [LNNetInspector shared];
inspector.host = @"192.168.1.8";
inspector.authToken = @"my-secret";    // 服务端设置了 TOKEN 时必填
inspector.onConnectionChange = ^(BOOL connected, NSString *reason) {
    NSLog(@"NetInspector connected=%@ reason=%@", @(connected), reason);
};
[inspector start];
```

**Swift**（通过桥接头 `#import "NetInspector.h"`）

```swift
#if DEBUG
let inspector = LNNetInspector.shared()
inspector.host = "192.168.1.8"
inspector.authToken = "my-secret"     // 可选
inspector.onConnectionChange = { connected, reason in
    print("NetInspector connected:", connected, reason ?? "")
}
inspector.start()
#endif
```

## 连接状态

- `inspector.wsConnected` — 当前 WebSocket 连接状态（只读快照）
- `inspector.onConnectionChange = ^(BOOL connected, NSString *reason) { … }` — 连接变化回调（主线程、去重后触发；`reason` 为断开原因）
- 令牌错误、IP 不通、代理拦截都会通过 `reason` 反映出来
- 断线自动重连（指数退避）；WS 连续失败 ≥2 次自动切换 HTTP 回退通道

## 安全说明

- 抓包数据含敏感信息，请配合服务端 `TOKEN` 使用（`authToken` 与服务端一致）
- 日志 WebSocket 会话设置了 `connectionProxyDictionary = @{}`，**绕过手机系统代理直连**（Wi-Fi 手动代理场景开代理也能用）
- 离线队列为明文 JSON（`Caches/netinspector.queue/`），调试结束可删除

完整的接入步骤（bridging header、ATS、AppDelegate 初始化位置、常见问题）见项目根目录 `README.md`。
