// swift-tools-version:5.9
import PackageDescription

/**
 * NetInspector — LAN 实时网络请求抓取 SDK（iOS）
 *
 * Swift 集成：
 *   .package(url: "https://github.com/porridgec/NetInspector", from: "1.0.0")
 *   import NetInspector
 *   let inspector = LNNetInspector.shared()
 *
 * 目标为纯 Objective-C（公开头在 Sources/NetInspector/include/），
 * SPM 会自动生成 Clang module，Swift 无需桥接头即可直接使用。
 * 真实流式传输需要 iOS 13+（NSURLSessionWebSocketTask）。
 */
let package = Package(
    name: "NetInspector",
    platforms: [
        .iOS(.v13),
    ],
    products: [
        .library(name: "NetInspector", targets: ["NetInspector"]),
    ],
    targets: [
        .target(
            name: "NetInspector",
            path: "client/ios/NetInspector/Sources/NetInspector",
            publicHeadersPath: "include"
        ),
    ]
)
