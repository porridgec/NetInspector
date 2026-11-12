//
//  DemoAppApp.swift
//  DemoApp
//
//  NetInspector demo — 启动即接管网络，配合 Mac 端 Dashboard 使用。
//

import SwiftUI
import DemoKit

@main
struct DemoAppApp: App {
    @StateObject private var store = DemoStore()

    init() {
        // 关键验证点：在 NetInspector -start 之前就把 SPM 包的
        // URLSession 单例创建出来（配置固化）——旧版 hook 会漏掉它，
        // 现在的 +load 无条件注入可以抓到。
        DemoKit.warmup()

        // 在 App 生命周期最早的时机启动拦截（仅 DEBUG）
        #if DEBUG
        DemoStore.bootstrapInspector()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
        }
    }
}
