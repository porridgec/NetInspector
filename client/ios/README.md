# NetInspector — iOS SDK

零依赖的 Objective-C 拦截 SDK（SPM 分发），把 App 的网络请求实时镜像到 Mac 端 Dashboard。Swift 项目经 SPM 直接 `import NetInspector`，无需桥接头；Objective-C 项目可直接引用公开头。

## 安装（Swift Package Manager）

Xcode → File → Add Package Dependencies… 输入：

```
https://github.com/porridgec/NetInspector
```

或在 `Package.swift`：

```swift
dependencies: [
    .package(url: "https://github.com/porridgec/NetInspector", from: "1.1.0")
],
targets: [
    .target(dependencies: [.product(name: "NetInspector", package: "NetInspector")])
]
```

要求 **iOS 13+**（实时流式传输使用 `NSURLSessionWebSocketTask`）。

## 快速使用

**Swift**

```swift
import NetInspector

#if DEBUG
LNNetInspector.shared()
    .host("192.168.1.8")
    .port(9090)
    .authToken("my-secret")           // 服务端设置了 TOKEN 时必填
    .start()

// 连接状态回调（可选）
LNNetInspector.shared().onConnectionChange = { connected, reason in
    print("NetInspector connected:", connected, reason ?? "")
}
#endif
```

**Objective-C**

```objc
#import <NetInspector/NetInspector.h>

[[[[LNNetInspector shared] host:@"192.168.1.8"] authToken:@"my-secret"] start];
```

## 链式配置 API

所有初始化参数均为链式方法（`-start` 之前调用，返回 self 可任意串联）：

| 方法 | 说明 | 默认 |
| --- | --- | --- |
| `.host(…)` | Mac 服务端 IP | — |
| `.port(…)` | 服务端端口 | 9090 |
| `.authToken(…)` | 访问令牌（服务端 TOKEN） | 无 |
| `.ignoredHosts(…)` | 不抓的域名（支持 `*.domain`） | 空 |
| `.maxBodyCaptureBytes(…)` | body 展示保留上限 | 256 KiB |
| `.maxStreamBodyBytes(…)` | 流式 body 内存缓冲上限 | 32 MiB |
| `.offlineQueueCapacity(…)` | 断网磁盘队列容量 | 500 |

## 包结构

```
client/ios/NetInspector/
└── Sources/NetInspector/
    ├── include/                 # 公开头（SPM 生成 Clang module）
    │   ├── NetInspector.h       # 伞头
    │   ├── LNNetInspector.h     # 公开门面：配置/令牌/连接状态
    │   ├── LNURLProtocol.h
    │   ├── LNURLSessionHook.h
    │   ├── LNWebSocketClient.h
    │   ├── LNOfflineQueue.h
    │   └── LNBodyCoding.h
    ├── LNNetInspector+Internal.h
    └── *.m                      # 实现
```

## 关键行为

- **拦截范围**：URLSession / NSURLConnection / Alamofire / AFNetworking / **SPM 包内网络**（`+load` 时无条件注入 swizzle，早于 `-start` 创建的 session 单例也能覆盖）
- **断线自愈**：指数退避重连 + 心跳；断网落盘，重连冲刷
- **代理环境**：日志 WS 会话绕过系统代理直连；WS 连续失败自动切 HTTP 回退
- **连接状态**：`wsConnected` 属性 + `onConnectionChange` 回调（主线程）
- **安全**：配合服务端 `TOKEN`；离线队列为明文 JSON（`Caches/netinspector.queue/`）

完整接入步骤（ATS、初始化位置、常见问题）见项目根目录 `README.md`。
