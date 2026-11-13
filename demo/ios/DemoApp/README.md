# NetInspector Demo App

一个开箱即用的 SwiftUI 演示工程：集成了 NetInspector 客户端，一键触发各种形态的网络请求，在 Mac 端 Dashboard 里实时查看。

## 运行

```bash
# ① Mac 端起服务（记住横幅里的 IP；建议设令牌）
cd server && TOKEN=my-secret npm start

# ② 用 Xcode 打开 demo 工程
open demo/ios/DemoApp/DemoApp.xcodeproj

# ③ 选择模拟器或真机，Cmd+R 运行
```

App 首页 → 「Mac 服务端」→ 填入横栏 IP（服务端启用了 `TOKEN` 时再填访问令牌）→ 「应用并重启」→ 浏览器打开 `http://<ip>:9090/?token=<令牌>`，然后点请求按钮即可实时看到流量。

状态灯含义：

| 指示灯 | 含义 |
| --- | --- |
| 灰 · 未启动 | inspector 未运行 |
| 🟠 重连中… | 已启动但 WS 未连通（下方橙字显示具体原因：令牌错误 / IP 不通等） |
| 🟢 已连接 | 实时通道正常 |

## 覆盖的请求形态（对应 Dashboard 各视图）

| 按钮 | 形态 | Dashboard 看点 |
| --- | --- | --- |
| GET JSON | `URLSession.shared` | JSON 树形折叠视图 |
| POST JSON | `.default` 配置 | 请求/响应 JSON、Headers |
| POST 表单 | `.ephemeral` 配置 | urlencoded 参数解析 |
| POST multipart | `uploadTask`（流式 body） | **Parts 视图**：字段/文件名/类型，JPEG 图片直接预览 |
| GET 图片 | `.ephemeral` 配置 | 二进制 Hex 预览 + 图片渲染 + 下载 |
| GET 404 | 状态码 | 列表橙色状态标记 |
| GET 重定向 ×3 | 302 链 | **每跳单独成条**（Charles 行为） |
| GET 慢请求 | 4s 延迟 | 耗时列分级着色 |
| GET 不可达 | 超时报错 | ERR 标记 + Overview 错误信息 |
| **GET via SPM 包 · 早建 session** | 本地 Swift Package（`DemoKit`） | 包内 `static let` 单例，**在 NetInspector `-start` 之前创建**——验证早建 session 也被拦截 |
| **GET via SPM 包 · ephemeral** | 本地 Swift Package | 包内调用时新建 session |

另有「自动连发」（每 3 秒随机）和「🔥 全部来一发」。

## 自动化 / UI 测试

支持启动参数（`xcrun simctl launch` 或 Xcode scheme 的 Arguments）：

- `-ni-autofire`：启动即自动连发
- `-ni-fireall`：启动 2 秒后每种请求各触发一次

App 的服务端地址/令牌持久化在 `UserDefaults`，可预先写入：

```bash
xcrun simctl spawn <UDID> defaults write com.example.netinspector.demo demo.serverHost 127.0.0.1
xcrun simctl spawn <UDID> defaults write com.example.netinspector.demo demo.serverPort 9090
xcrun simctl spawn <UDID> defaults write com.example.netinspector.demo demo.serverToken demo-secret
```

## 结构

```
DemoApp/
├── project.yml                    # xcodegen 配置（含本地包 DemoKit 依赖）
├── DemoApp.xcodeproj              # 已生成，直接打开即可
└── DemoApp/
    ├── DemoAppApp.swift           # @main；启动时先 DemoKit.warmup() 再 start
    ├── ContentView.swift          # 控制台 UI（含连接状态徽标）
    ├── DemoStore.swift            # 状态/配置/令牌/连接状态/自动连发
    ├── NetworkDemo.swift          # 各种请求用例（不同 session 形态 + SPM 包）
    ├── DemoAssets.swift           # 真实 JPEG（multipart 演示用，生成产物）
    └── Info.plist                 # 含 ATS 例外（demo 专用）
../DemoKit/                        # 本地 SPM 包（模拟第三方包的网络层）
```

> NetInspector SDK 通过 **SPM 本地 path 依赖**接入（指向仓库根 `Package.swift`），
> Swift 侧 `import NetInspector`，与真实用户集成方式一致、无快照拷贝。

## 已在真机/模拟器环境验证

- iPhone 17 模拟器 (iOS 26.2) + macOS Node 服务端
- 全部 11 种形态捕获 ✅（含 **SPM 包内早建 session / ephemeral session**）
- 重定向逐跳 ✅、multipart Parts 视图 ✅、图片预览 ✅、错误事件 ✅、
  断线落盘重连冲刷 ✅、手机代理场景（代理绕过 + HTTP 回退）✅、
  **TOKEN 鉴权模式全链路 ✅**
