//
//  DemoAppApp.swift
//  DemoApp
//
//  NetInspector demo — 启动即接管网络，配合 Mac 端 Dashboard 使用。
//

import SwiftUI

@main
struct DemoAppApp: App {
    @StateObject private var store = DemoStore()

    init() {
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
