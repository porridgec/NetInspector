# NetInspector — 局域网实时网络请求抓取与查看系统

在没有 Charles / Proxyman（MitM 证书 + 代理）条件下，为 iOS App 提供的一套**内嵌式抓包方案**：

```
┌─────────────────────────── iOS App ───────────────────────────┐
│  URLSession / Alamofire / AFNetworking / NSURLConnection …    │
│        │ (URLProtocol 拦截 + SessionConfiguration swizzle)     │
│        ▼                                                      │
│  LNURLProtocol ──▶ LNNetInspector ──▶ LNWebSocketClient       │
│                          │  断线时落盘（离线队列）              │
└──────────────────────────┼────────────────────────────────────┘
                           │ WebSocket  ws://<mac-ip>:9090/log
                           ▼
┌────────────────────────── Mac ────────────────────────────────┐
│  Node.js 服务（express + ws）── 环形缓冲区（500 条）            │
│        │                                                      │
│        ▼                                                      │
│  Web Dashboard（Charles/Proxyman 风格双栏 UI）                 │
│  http://<mac-ip>:9090                                         │
└───────────────────────────────────────────────────────────────┘
```

## 目录结构

```
LogServer/
├── server/                     # Mac 端：Node.js 服务 + Web Dashboard
│   ├── index.js                # 入口：HTTP API + WebSocket + 静态页面
│   ├── demo-client.js          # 模拟设备回放假流量（无真机也能开发调试 UI）
│   ├── src/
│   │   ├── logStore.js         # 固定容量环形缓冲区
│   │   └── network.js          # 枚举本机局域网 IP
│   └── public/                 # Dashboard（纯原生 HTML/CSS/JS，无构建步骤）
│       ├── index.html
│       ├── multipart.js        # multipart/form-data 解析器（Node 可测）
│       ├── style.css
│       └── app.js
├── client/ios/NetInspector/    # iOS 端：Objective-C 模块（Swift/OC 通用）
│   ├── NetInspector.h          # 伞头文件
│   ├── LNNetInspector.h/.m     # 公开门面（启停/配置）
│   ├── LNURLProtocol.h/.m      # 录制型 URLProtocol
│   ├── LNURLSessionHook.h/.m   # URLSessionConfiguration swizzle
│   ├── LNWebSocketClient.h/.m  # WebSocket + 指数退避重连 + 心跳
│   ├── LNOfflineQueue.h/.m     # 磁盘离线队列
│   └── LNBodyCoding.h/.m       # Body 安全编码
└── demo/ios/DemoApp/           # 演示工程（SwiftUI，直接打开编译运行）
    ├── project.yml              # xcodegen 配置
    ├── DemoApp.xcodeproj        # 已生成
    └── DemoApp/                 # 源码 + NetInspector 快照 + 各种请求用例
```

---

## 一、最快体验（3 分钟）

```bash
# ① Mac 端起服务
cd server && npm install && npm start

# ② 打开 demo 工程，Cmd+R 跑起来（模拟器/真机均可）
open demo/ios/DemoApp/DemoApp.xcodeproj

# ③ App 里填入服务端横栏 IP → 点「应用并重启」→ 点请求按钮
#    浏览器打开 http://<mac-ip>:9090 实时查看
```

> 没有真机/不想开 Xcode？另开终端 `npm run demo` 用 Node 模拟设备回放流量。

---

## 二、Mac 端使用说明

### 安全模型（重要）

NetInspector 抓取的是 **App 的完整请求/响应**——包含登录 token、Cookie、密码等敏感数据。公网/多人局域网部署前请务必了解：

| 防护 | 说明 |
| --- | --- |
| **访问令牌（推荐）** | `TOKEN=your-secret npm start`。启用后 Dashboard、REST API、WebSocket、HTTP 回退通道**全部**需要令牌（浏览器打开 `http://ip:9090/?token=your-secret`；iOS 端设置 `inspector.authToken`）。未设置时服务端启动横幅会给出告警。 |
| **默认仅监听局域网** | 服务监听 `0.0.0.0`（局域网可访问）。如需更严格：`HOST=127.0.0.1` 仅本机（配 iPhone 真机时不可用）。 |
| **DNS rebinding 防护** | 校验 `Host` 头（仅允许 localhost / IP 字面量 / `*.local` / 本机主机名）。 |
| **跨站 WebSocket 防护** | 校验 `Origin`：浏览器页面必须同主机，防任意网页跨站偷读抓包数据。 |
| **XSS 防护** | Dashboard 所有不可信内容一律 `textContent` 渲染；响应带严格 CSP；图片预览仅允许栅格格式 mime；事件字段过滤 `__proto__` 防原型污染。 |
| **终端注入防护** | 控制台输出剥离控制字符（防 ANSI 逃逸注入）。 |
| **传输加密** | 局域网明文 `ws://` / `http://`。仅建议在可信网络使用；不要在公共 Wi-Fi 上抓取敏感流量。 |
| **设备端落地数据** | 离线队列文件位于 App `Caches/netinspector.queue/`（明文 JSON），调试结束可删除。 |

> 原则：这是**本地调试工具**，请只在你信任的局域网内运行，并始终设置 TOKEN。


```bash
cd server
npm install
npm start
# 或自定义：PORT=9090 MAX_LOGS=500 MAX_BODY_BYTES=262144 npm start
```

启动后终端会打印本机局域网 IP 和对应的 iOS 配置代码：

```
⚡ NetInspector server is running
  Dashboard :  http://localhost:9090
               http://192.168.1.8:9090
  iOS host  :  LNNetInspector.shared.host = @"192.168.1.8"   port = 9090
```

浏览器打开 `http://<mac-ip>:9090` 即可看到 Dashboard。

> **没有真机也想先看看效果？** 另开一个终端运行 `npm run demo`，会模拟一台设备持续回放 JSON / 表单 / 图片 / 404 / 500 / 超时 / 重定向等真实形态的流量。

### Dashboard 功能

- **请求列表**：Method / Host / Path（可拆分显示）/ Status / 耗时 / 响应大小 / 时间，多设备时显示 Device 列
- **列显示配置**：工具栏「▾ 列」菜单，每个列（含 URL 整列）可独立开关并持久化
- **过滤**：搜索框支持 `关键词`、`method:GET`、`status:404`、`status:5xx`、`status:>=400`、`host:api`（空格分隔 = AND），另有 Method / 状态分类下拉
- **暂停/继续**：`⏸ Pause` 按钮或空格键暂停实时刷新（后台继续缓存，恢复时批量刷入）
- **自动跟随滚动**：滚离底部自动暂停跟随，出现 "↓ new requests" 悬浮按钮
- **详情三 Tab**：
  - *Overview*：URL、状态、起止时间、耗时、Body 大小/类型、错误信息、Query 参数
  - *Request / Response*：Headers 表格、Body 查看器——
    - JSON：树形折叠 + 语法着色、Raw 切换
    - **multipart/form-data：Parts 视图**（每个 part 显示字段名 / 文件名 / Content-Type / 大小 / 截断标记；文本字段值内联显示；文件 part 支持 Hex 预览、图片直接预览、单独 Download；Parts ↔ Raw 一键切换；兼容带引号 boundary 与 LF 换行的宽容解析）
    - 二进制：Hex 预览 + 整体下载、图片直接预览
    - 表单：urlencoded 参数解析
- **Copy as cURL**：一键把请求还原为 curl 命令
- **键盘操作**：↑/↓ 切换选中请求，空格暂停
- 可拖拽分割条（双击复位），布局宽度本地记忆

### HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/status` | 缓冲区容量/条数、累计接收数 |
| `GET` | `/api/logs?limit=&offset=` | 日志列表（最新在前，不含 body） |
| `GET` | `/api/logs/:id` | 单条完整事件（含 body） |
| `DELETE` | `/api/logs` | 清空缓冲区 |

WebSocket：设备接入 `ws://<ip>:9090/log`，浏览器接入 `ws://<ip>:9090/dashboard`。

---

## 三、iOS 端接入指南

### 1. 拷贝文件

把 `client/ios/NetInspector/` 下 **10 个文件**（`.h` + `.m`）拖进 Xcode 工程（勾选 Add to targets，无需 Copy Sources 之外的任何配置）。**零第三方依赖**。

### 2. ATS 例外（仅 Debug）

`ws://` 明文连接受 ATS 限制。给 **Debug** 配置的 Info.plist 加本地网络例外（Release 不受影响）：

```xml
<!-- Debug Info.plist -->
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
</dict>
```

> 若 App 的 Debug 构建和 Release 共用 Info.plist，可在 Xcode → target → Info 里按 Configuration 拆分，或用 xcconfig 控制该 key 只在 `$(CONFIGURATION)=Debug` 时生效。

### 3. 初始化（AppDelegate）

**Objective-C：**

```objc
// AppDelegate.m
#import "NetInspector.h"

- (BOOL)application:(UIApplication *)application
        didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {

#if DEBUG
    [[LNNetInspector shared] startWithHost:@"192.168.1.8"   // ← 你的 Mac IP
                                      port:9090];
#endif
    return YES;
}
```

**Swift：**

先配置桥接头（Target → Build Settings → Objective-C Bridging Header）：

```objc
// YourApp-Bridging-Header.h
#import "NetInspector.h"
```

```swift
// AppDelegate.swift / @main App struct 的 init()
#if DEBUG
let inspector = LNNetInspector.shared()
inspector?.host = "192.168.1.8"   // ← 你的 Mac IP
inspector?.start()
#endif
```

> SwiftUI 生命周期没有 AppDelegate 时，放在 `App.init()` 或首个 Scene 的 `onAppear` 中都可以（越早越好，见下方"拦截范围"）。

### 4. 常用配置（可选，均在 `start` 之前设置）

```objc
LNNetInspector *inspector = [LNNetInspector shared];
inspector.host = @"192.168.1.8";
inspector.port = 9090;                          // 默认 9090
inspector.ignoredHosts = @[@"*.sentry.io",
                           @"logs.example.com"]; // 不想抓的域名（支持通配符）
inspector.maxBodyCaptureBytes = 256 * 1024;     // 单个 body 保留上限（默认 256 KiB）
inspector.maxStreamBodyBytes   = 32 * 1024 * 1024; // 流式 body 缓冲上限（默认 32 MiB）
inspector.offlineQueueCapacity = 500;           // 断网时磁盘队列容量（默认 500）
```

### 5. 拦截范围说明

| 流量来源 | 是否拦截 | 原理 |
| --- | --- | --- |
| `URLSession`（默认/临时配置） | ✅ | swizzle `NSURLSessionConfiguration`，把 `LNURLProtocol` 插入 `protocolClasses` |
| `URLSession.shared` / `NSURLConnection` | ✅ | 全局 `[NSURLProtocol registerClass:]` |
| **Swift Package（SPM）内的网络请求** | ✅ | 与主项目同进程、同一 URL Loading System。hook 在 `+load` 时**无条件注入**（早于任何 Swift 代码执行），因此包内 `static let session = URLSession(...)` 这类"早于 `-start` 创建"的长寿单例同样被覆盖；真正的开关在 `canInitWithRequest:`，未启用时零开销 |
| Alamofire / AFNetworking / Moya / SDWebImage 等 | ✅ | 全部基于 URLSession，被上面两条覆盖 |
| Network.framework（NWConnection）/ 自定义 socket | ❌ | 不经过 URL Loading System |
| WKWebView | ❌ | 网络请求发生在独立进程，URLProtocol 无法覆盖（可用 `WKURLSchemeHandler` 另行扩展） |
| App Extension / Widget / Watch 进程 | ❌ | 独立进程，需在对应 target 单独集成并启动 |
| `backgroundSessionConfiguration` | ❌ | 系统 API 限制，background session 忽略 protocolClasses |
| 命中缓存的请求 | 可能不显示 | 缓存命中时加载系统不会发起请求；本工具刻意不改缓存策略以免影响 App 行为 |
| 下载/上传任务的 body | 部分 | 请求 body 已尽力捕获；超大（>32 MiB）流式 body 只记录截断说明 |

### 6. 工作机制（为什么不会破坏 App 网络）

- **纯镜像式设计**：`LNURLProtocol` 用一个内部 `NSURLSession` 真实转发请求，数据原样回投给 App 的 `URLProtocolClient`，转发链路对业务完全透明；
- **multipart / 大上传安全**：流式请求体 ≤32 MiB 常驻内存，超出自动落盘临时文件转发（结束后清理），**任何体积的上传都不会被截断或破坏**，展示层仍只保留 256 KiB；
- **防递归**：内部转发的请求打标记跳过二次拦截；日志服务自身的连接按 host 过滤，不会反馈循环；
- **Body 上限**：展示层最多保留 256 KiB（可配），转发不受影响；
- **内存安全**：服务端环形缓冲区固定 500 条；设备端离线队列有容量与字节双上限；
- **断线自愈**：指数退避重连（0.5s→30s + 抖动）+ 20s 心跳；断网期间事件写入 `Caches/netinspector.queue/`，连上后分批冲刷。

---

## 四、常见问题

**列表一直是空的？**
1. iPhone 和 Mac 是否在同一 Wi-Fi / 网段？（公司网/酒店网常开 AP 隔离，手机热点最稳）
2. Mac IP 是否变了？（server 启动横幅里有最新 IP，**以横幅为准**，不要用手机自己的 IP）
3. Debug Info.plist 是否加了 ATS 例外？（控制台会有 ATS 报错日志）
4. macOS 防火墙是否放行了 node 的入站连接？

**Body 显示不完整 / 提示「已截断」？**

Body 经过三层独立上限，缺哪层调哪层（Dashboard 横幅会标明**是谁截断的**）：

| 层 | 参数 | 默认 | 说明 |
| --- | --- | --- | --- |
| iOS 捕获 | `maxBodyCaptureBytes` | 256 KiB | `-start` 前设置；二进制以 base64 传输会膨胀 4/3 |
| iOS 流式缓冲 | `maxStreamBodyBytes` | 32 MiB | `uploadTask`/multipart 走流式路径，**捕获量不会超过它**；要抓 >32 MiB 的上传需同时调大 |
| 服务端存储 | `MAX_BODY_BYTES`（env） | 256 KiB | 环形缓冲区内所有事件的内存占用 = MAX_LOGS × MAX_BODY_BYTES，调大时建议同时调小 `MAX_LOGS` |

```bash
# 例：完整保留 128 MiB body（传输层消息上限会自动跟随，无需另设）
MAX_BODY_BYTES=$((128*1024*1024)) MAX_LOGS=50 npm start
```

> 服务端发生截断时控制台会打印醒目告警（前 3 次）；Dashboard 横幅区分
> 「服务端存储上限」/「客户端捕获上限」并显示 `已捕获 / 原始大小`。

**手机开着代理（Wi-Fi 手动代理 / Shadowrocket / Surge / 公司网关）导致 `-1011 從伺服器傳來錯誤的回應`？**

原因：代理把 WebSocket 的 `Upgrade` 请求当普通 HTTP 处理，返回了错误页而不是 `101` 升级。客户端已内置**双重应对**，开代理也能用：

1. **自动绕过代理直连**：日志 WebSocket 会话设置了 `connectionProxyDictionary = @{}`，Wi-Fi 手动代理/PAC 场景下直接绕开代理连 Mac；
2. **HTTP 回退通道**：若 ws 连续失败 ≥2 次（VPN 型代理会截获所有流量，绕不过），自动切换为 `POST http://<mac>:9090/log` 逐批投递（普通 HTTP 常能穿过只拦 WebSocket 的代理层）；ws 恢复后自动切回。控制台会打印 `⇄ 启用 HTTP 回退通道`。

若 HTTP 回退也不通（VPN 全量转发且规则不放行内网），需在代理 App 的分流规则里把 Mac IP（如 `10.190.228.5`）设为 **DIRECT**，或让 Mac 与手机处于同一热点。验证可达性：手机 Safari 打开 `http://<mac-ip>:9090`，Dashboard 能加载即网络通。

**为什么没有 DNS/TLS 耗时分解？**
`URLProtocol` 层看不到协议栈细节，只统计端到端总耗时。需要精细时间线时可在抓到问题请求后用 `Copy as cURL` 在 Mac 上复现分析。

**App 端误报 "iOS 13 以下"？**
实时传输需要 iOS 13+；低版本设备上事件仍会写磁盘队列，升级/换设备后连接成功即自动冲刷。

**清理设备端离线队列？**
删除 App 重装，或删除 App 沙盒 `Library/Caches/netinspector.queue/` 目录。

---

## License

MIT — 自由用于个人与商业项目。
