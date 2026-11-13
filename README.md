# NetInspector — 局域网实时网络请求抓取与查看系统

在没有 Charles / Proxyman（MitM 证书 + 代理）条件下，为 iOS App 提供的一套**内嵌式抓包方案**：App 内嵌轻量拦截器，把请求/响应实时推送到 Mac 上的 Web Dashboard。

```
┌─────────────────────────── iOS App ───────────────────────────┐
│  URLSession / Alamofire / AFNetworking / SPM Package …        │
│        │ (URLProtocol 拦截 + SessionConfiguration swizzle)     │
│        ▼                                                      │
│  LNURLProtocol ──▶ LNNetInspector ──▶ LNWebSocketClient       │
│                          │  断线时落盘（离线队列）              │
└──────────────────────────┼────────────────────────────────────┘
                           │ WebSocket  ws://<mac>:9090/log[?token=…]
                           │ HTTP 回退   POST http://<mac>:9090/log
                           ▼
┌────────────────────────── Mac ────────────────────────────────┐
│  Node.js 服务（express + ws）── 环形缓冲区（默认 500 条）        │
│        │                                                      │
│        ▼                                                      │
│  Web Dashboard（Charles/Proxyman 风格双栏 UI）                 │
│  http://<mac>:9090[?token=…]                                  │
└───────────────────────────────────────────────────────────────┘
```

**特性一览**

- 拦截 URLSession / NSURLConnection / Alamofire / AFNetworking / **SPM 包**，Swift 与 Objective-C 项目通用（客户端为 OC 实现）
- 实时 WebSocket 流 + **手机代理绕过** + **HTTP POST 回退通道**（只拦 WebSocket 的代理也能用）
- 断网/断线自动落盘（磁盘离线队列），重连后批量冲刷
- Charles 式 Dashboard：Host/Path 拆分列、列显示独立开关、搜索过滤、暂停跟随、重定向逐跳、JSON 树形折叠、**multipart Parts 视图**、图片预览、Copy as cURL
- 内置安全模型：可选 TOKEN（cookie 持久化）、Host/Origin 校验、CSP、防原型污染

## 目录结构

```
LogServer/
├── server/                     # Mac 端：Node.js 服务 + Web Dashboard
│   ├── index.js                # 入口：HTTP API + WebSocket + 安全中间件 + 静态页面
│   ├── demo-client.js          # 模拟设备回放假流量（无真机也能调试 UI）
│   ├── src/
│   │   ├── logStore.js         # 固定容量环形缓冲区（截断来源标记）
│   │   └── network.js          # 枚举本机局域网 IP
│   └── public/                 # Dashboard（纯原生 HTML/CSS/JS，无构建步骤）
│       ├── index.html          # 双栏布局 + 授权卡片 + 列菜单容器
│       ├── multipart.js        # multipart/form-data 字节级解析器（Node 可测）
│       ├── style.css
│       └── app.js
├── Package.swift               # Swift Package 清单（SDK 以 SPM 分发）
├── client/ios/NetInspector/    # iOS 端 SDK（纯 Objective-C，SPM 布局）
│   └── Sources/NetInspector/
│       ├── include/            # 公开头（自动生成 Clang module → import NetInspector）
│       │   ├── NetInspector.h  # 伞头文件
│       │   ├── LNNetInspector.h
│       │   ├── LNURLProtocol.h
│       │   ├── LNURLSessionHook.h
│       │   ├── LNWebSocketClient.h
│       │   ├── LNOfflineQueue.h
│       │   └── LNBodyCoding.h
│       ├── LNNetInspector+Internal.h
│       └── *.m                 # 门面/拦截器/WS/离线队列/Body 编码
└── demo/ios/                   # 演示工程
    ├── DemoApp/                # SwiftUI Demo（xcodegen 工程，直接打开运行）
    └── DemoKit/                # 本地 SPM 包（验证包内网络请求同样被拦截）
```

---

## 一、最快体验（3 分钟）

```bash
# ① Mac 端起服务（建议设令牌；不设会有安全告警）
cd server && npm install
TOKEN=my-secret npm start          # 无令牌：npm start

# ② 打开 demo 工程，Cmd+R（模拟器/真机均可）
open demo/ios/DemoApp/DemoApp.xcodeproj

# ③ App 里填服务端横栏 IP（+ 令牌）→「应用并重启」→ 点请求按钮
#    浏览器打开 http://<mac-ip>:9090/?token=my-secret 实时查看
```

> 没有真机/不想开 Xcode？另开终端 `TOKEN=my-secret npm run demo` 用 Node 模拟设备回放流量。

---

## 二、Mac 端

### 启动与环境变量

```bash
cd server && npm install
npm start
```

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `9090` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址（`127.0.0.1` = 仅本机） |
| `TOKEN` | 空（不鉴权） | 访问令牌；设置后 Dashboard/API/WS/HTTP 回退全部需要 |
| `MAX_LOGS` | `500` | 环形缓冲区条数 |
| `MAX_BODY_BYTES` | `262144`（256 KiB） | 单 body 存储上限；WS 消息与 HTTP 回退上限自动跟随 |

启动横幅会打印本机局域网 IP、Dashboard 地址（含 token）和 iOS 配置提示。

### 安全模型（重要）

NetInspector 抓取的是 **App 的完整请求/响应**——包含登录 token、Cookie、密码等敏感数据。多人局域网/公司网部署前请务必了解：

| 防护 | 说明 |
| --- | --- |
| **访问令牌（推荐）** | `TOKEN=your-secret npm start`。Dashboard、REST API、WebSocket、HTTP 回退通道**全部**受保护。浏览器打开 `http://ip:9090/?token=your-secret` 校验通过后服务端下发 **HttpOnly cookie（1 年）**，此后新标签页/重启浏览器自动免 token；iOS 端设置 `inspector.authToken`。未设置时启动横幅会醒目告警。 |
| **授权卡片** | 未授权打开 Dashboard 会显示粘贴令牌的输入框，校验错误有红字提示（服务端 `/api/auth` 为唯一鉴权状态来源）。 |
| **DNS rebinding 防护** | 校验 `Host` 头（仅允许 localhost / IP 字面量 / `*.local` / 本机主机名）。 |
| **跨站 WebSocket 防护** | 校验 `Origin`：浏览器页面必须同主机，防任意网页跨站偷读抓包数据。 |
| **XSS 防护** | 不可信内容一律 `textContent` 渲染；严格 CSP + XFO + nosniff；图片预览仅允许栅格 mime；事件字段过滤 `__proto__`。 |
| **终端注入防护** | 控制台输出剥离控制字符。 |
| **传输加密** | 局域网明文 `ws://` / `http://`。仅建议在可信网络使用。 |
| **设备端落地数据** | 离线队列位于 App `Caches/netinspector.queue/`（明文 JSON），调试结束可删除。 |

> 原则：这是**本地调试工具**，只在信任的局域网内运行，并始终设置 TOKEN。

### Dashboard 功能

- **请求列表**：Method / **Host** / **Path**（URL 拆分，query 摘要）/ Status / 耗时 / 响应大小 / 时间，多设备时显示 Device
- **列显示配置**：工具栏「▾ 列」菜单，9 个列（含可选整段 URL、Device）独立开关并持久化；「恢复默认」一键还原
- **导出 / 导入**：复选框勾选或**鼠标拖拽框选**（从已选行起拖 = 取消该范围，从未选行起拖 = 勾选该范围，不重置已有选择）→ **必须先勾选**才可导出为 JSON（含完整 body，可无损回导）。Chromium 系浏览器弹出**系统保存对话框**（自选目录/文件名，浏览器自动记住上次目录；自定义文件名也会被记忆）；Safari/Firefox 回退为直接下载。导入写回环形缓冲区（按 id 去重），刷新与多端可见
- **过滤**：搜索支持 `关键词`、`method:GET`、`status:404`、`status:5xx`、`status:>=400`、`host:api`（空格 = AND），另有 Method / 状态分类下拉
- **暂停/继续**（空格键）、**自动跟随时滚动**（滚离底部暂停，出现 ↓ new requests 按钮）
- **详情三 Tab**：
  - *Overview*：URL、状态、起止时间、耗时、Body 大小/类型（含截断来源）、错误信息、Query 参数
  - *Request / Response*：Headers 表格、Body 查看器——
    - JSON：树形折叠 + 语法着色、Raw 切换；**默认全部展开**，支持「全部展开 / 全部折叠」一键操作（折叠箭头可单独点击）
    - **multipart/form-data：Parts 视图**（字段名 / 文件名 / Content-Type / 大小 / 截断标记；文本值内联；文件 Hex 预览、图片直接渲染、单独 Download；兼容引号 boundary 与 LF 换行）
    - 二进制：Hex 预览 + 下载；图片直接预览（栅格格式白名单）
    - 表单：urlencoded 参数解析
- **Copy as cURL** 一键还原请求
- 键盘 ↑/↓ 切换请求；可拖拽分割条（双击复位）；布局与列配置本地记忆

### HTTP API

除 `/api/auth` 外均需令牌（query `?token=`、header `x-ni-token` 或 cookie 任一）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/auth[?token=]` | 鉴权状态 `{tokenRequired, authorized}`；带正确 token 时下发 cookie |
| `GET` | `/api/status` | 缓冲区容量/条数、累计接收数 |
| `GET` | `/api/logs?limit=&offset=` | 日志列表（最新在前，不含 body） |
| `GET` | `/api/logs/:id` | 单条完整事件（含 body） |
| `DELETE` | `/api/logs` | 清空缓冲区 |
| `POST` | `/api/export` | 批量导出完整事件（`{ids:[...]}`，空则全部） |
| `POST` | `/api/import` | 导入导出文件中的事件（按 id 去重） |
| `POST` | `/log` | HTTP 回退投递通道（与 WS 相同消息格式） |
| `GET` | `/ping` | 探活 |

WebSocket 升级：设备 `ws://<ip>:9090/log`，浏览器 `ws://<ip>:9090/dashboard`；未知路径显式 404。

---

## 三、iOS 端接入指南

### 1. 接入方式（SPM 推荐）

**Swift Package Manager：**

Xcode → File → Add Package Dependencies… → 输入仓库地址：

```
https://github.com/porridgec/NetInspector
```

或在 `Package.swift` 中：

```swift
.package(url: "https://github.com/porridgec/NetInspector", from: "1.1.0")
// target 依赖：
.product(name: "NetInspector", package: "NetInspector")
```

Swift 侧直接 `import NetInspector`（SPM 自动生成 Clang module，**无需桥接头**）；调用方式见下方示例。

**手工拷贝（不便使用 SPM 时）：**

把 `client/ios/NetInspector/Sources/NetInspector/` 下的 `.m`、私有头与 `include/` 内公开头拖进 Xcode 工程；Swift 项目配一个桥接头 `#import "NetInspector.h"`。

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

> 若 Debug/Release 共用 Info.plist，可按 Configuration 拆分，或用 xcconfig 控制该 key 只在 Debug 生效。

### 3. 初始化（Swift / Objective-C）

**Swift**（SPM：`import NetInspector`；手工集成：桥接头 `#import "NetInspector.h"`）：

```swift
import NetInspector

#if DEBUG
LNNetInspector.shared()
    .host("192.168.1.8")            // ← 服务端横幅里的 IP
    .port(9090)
    .authToken("my-secret")         // ← 服务端设置了 TOKEN 时必填
    .start()

// 连接状态回调（可选）
LNNetInspector.shared().onConnectionChange = { connected, reason in
    print("NetInspector connected:", connected, reason ?? "")
}
#endif
```

**Objective-C：**

```objc
#if DEBUG
[[[[LNNetInspector shared] host:@"192.168.1.8"] authToken:@"my-secret"] start];
#endif
```

> SwiftUI 没有 AppDelegate 时放在 `App.init()`（越早越好，尽量不漏启动期请求）。

### 4. 配置项（均在 `start` 之前设置）

```objc
[[[[[[LNNetInspector shared]
    host:@"192.168.1.8"]
    port:9090]                      // 默认 9090
    authToken:@"my-secret"]         // 可选，与服务端 TOKEN 一致
    ignoredHosts:@[@"*.sentry.io"]] // 不想抓的域名（支持通配符）
    maxBodyCaptureBytes:256 * 1024] // body 保留上限（默认 256 KiB）
    start];                         // 也可链上 maxStreamBodyBytes / offlineQueueCapacity

// 连接状态（主线程回调；也可读 inspector.wsConnected）
LNNetInspector.shared().onConnectionChange = ^(BOOL connected, NSString *reason) { ... };
```

Swift 等价写法：`.host("…").port(9090).authToken("…").ignoredHosts([…]).start()`

### 5. 拦截范围

| 流量来源 | 是否拦截 | 原理 |
| --- | --- | --- |
| `URLSession`（默认/临时配置） | ✅ | swizzle `NSURLSessionConfiguration`，把 `LNURLProtocol` 插入 `protocolClasses` |
| `URLSession.shared` / `NSURLConnection` | ✅ | 全局 `[NSURLProtocol registerClass:]` |
| **SPM 包内网络请求** | ✅ | 同进程同 URL Loading System；hook 在 `+load` 时**无条件注入**，包内早于 `-start` 创建的长寿 session 同样覆盖 |
| Alamofire / AFNetworking / Moya / SDWebImage | ✅ | 全部基于 URLSession |
| Network.framework / 自定义 socket | ❌ | 不经过 URL Loading System |
| WKWebView | ❌ | 独立进程（可用 `WKURLSchemeHandler` 扩展） |
| App Extension / Widget / Watch | ❌ | 独立进程，需在对应 target 单独集成 |
| `backgroundSessionConfiguration` | ❌ | 系统限制，忽略 protocolClasses |
| 命中缓存的请求 | 可能不显示 | 缓存命中不发起请求；本工具刻意不改缓存策略 |
| 超大流式 body 的展示 | 截断说明 | 转发永远完整；展示受 `maxBodyCaptureBytes` / `MAX_BODY_BYTES` 限制 |

### 6. 工作机制（为什么不会破坏 App 网络）

- **纯镜像式转发**：内部 `NSURLSession` 真实加载并把数据原样回投，业务无感知；
- **multipart / 大上传安全**：流式请求体 ≤32 MiB 常驻内存，超出自动落盘临时文件转发（结束后清理），**任何体积上传都不会被截断**；
- **防递归**：内部请求打标记、日志服务连接按 host 过滤；
- **断线自愈**：指数退避重连（0.5s→30s + 抖动）+ 20s 心跳；断网落盘，连上批量冲刷；
- **代理环境**：日志 WS 会话绕过系统代理直连；WS 连续失败 ≥2 次自动切 HTTP 回退通道。

---

## 四、Demo 工程

`demo/ios/DemoApp/` 是可直接运行的 SwiftUI 演示（详见其 README）：

- 11 种请求形态按钮：JSON/表单/**multipart（带真图）**/图片/404/重定向/慢请求/不可达/**SPM 包请求 ×2**
- 服务端配置（IP/端口/令牌）持久化 + **实时连接状态**（已连接 / 重连中… / 未启动，失败原因可见）
- 自动连发（每 3 秒随机）与「全部来一发」
- 启动参数：`-ni-autofire`、`-ni-fireall`（自动化/截图用）
- 内含本地 SPM 包 `DemoKit`，验证包内早建 session 同样被拦截

---

## 五、常见问题

**列表一直是空的？**
1. iPhone 和 Mac 是否在同一 Wi-Fi / 网段？（公司网/酒店网常开 AP 隔离，手机热点最稳）
2. Mac IP 是否变了？**以服务端横幅为准**，不要用手机自己的 IP
3. Debug Info.plist 是否加了 ATS 例外？
4. 服务端是否启用了 TOKEN 而 iOS 端没配 `authToken`？（Dashboard 顶部会显示「需要访问令牌」）
5. macOS 防火墙是否放行 node 入站连接？

**Dashboard 显示「需要访问令牌」/ 令牌验证失败？**
- 服务端控制台会打印 `[!] 401 … (token 缺失 / 不匹配)`，据此判断是没带还是值不对
- 令牌含 `$`、空格等特殊字符时**必须用引号**启动：`TOKEN='my secret' npm start`
- 直接在授权卡片粘贴令牌即可（校验通过后 cookie 固化，之后新标签页/重启浏览器都免输入）
- 确认服务端实际拿到的值：同一终端 `echo "[$TOKEN]"`

**Dashboard 一直显示 connecting… / 页面空白？**
1. 打开浏览器开发者工具 Console，看是否有红色 JS 报错（发 issue 时附上）
2. 静态资源已配置 `no-cache`（每次重验证）且引用带版本号，正常刷新即最新；极端情况用无痕窗口排除缓存
3. Network 面板看 `/api/auth` 是否 200、`/dashboard` WS 是否 101

**Body 显示不完整 / 提示「已截断」？**
三层独立上限（Dashboard 横幅会标明是谁截断的）：

| 层 | 参数 | 默认 |
| --- | --- | --- |
| iOS 捕获 | `maxBodyCaptureBytes` | 256 KiB |
| iOS 流式缓冲 | `maxStreamBodyBytes` | 32 MiB（>32 MiB 上传要完整捕获需同时调大） |
| 服务端存储 | `MAX_BODY_BYTES` | 256 KiB（内存 ≈ MAX_LOGS × MAX_BODY_BYTES，调大时建议调小 MAX_LOGS） |

```bash
MAX_BODY_BYTES=$((128*1024*1024)) MAX_LOGS=50 npm start
```

**手机开着代理（Wi-Fi 手动代理 / Shadowrocket / Surge / 公司网关）导致 `-1011 從伺服器傳來錯誤的回應`？**

代理把 WebSocket 的 `Upgrade` 当普通 HTTP 处理。客户端双重应对：

1. **自动绕过代理直连**（`connectionProxyDictionary = @{}`，Wi-Fi 手动代理/PAC 直接绕开）
2. **HTTP 回退通道**：ws 连续失败 ≥2 次自动切 `POST /log` 逐批投递；ws 恢复自动切回（控制台打印 `⇄ 启用 HTTP 回退通道`）

若回退也不通（VPN 全量转发），在代理 App 分流规则里把 Mac IP 设为 **DIRECT**，或让 Mac 加入手机热点。

**`npm run demo` 报 401？**
demo 与服务器需用同一 TOKEN：`TOKEN=xxx npm run demo`。

**为什么没有 DNS/TLS 耗时分解？**
`URLProtocol` 层看不到协议栈细节，只统计端到端总耗时；需要精细时间线可用 Copy as cURL 在 Mac 复现。

**App 端提示 "iOS 13 以下"？**
实时传输需要 iOS 13+；低版本事件仍写磁盘队列，升级后连接成功自动冲刷。

**清理设备端离线队列？**
重装 App，或删除沙盒 `Library/Caches/netinspector.queue/`。

---

## License

MIT — 自由用于个人与商业项目。
