//
//  DemoStore.swift
//  DemoApp
//

import Foundation
import SwiftUI

@MainActor
final class DemoStore: ObservableObject {
    private static let hostKey = "demo.serverHost"
    private static let portKey = "demo.serverPort"
    private static let tokenKey = "demo.serverToken"

    @Published var host: String {
        didSet { UserDefaults.standard.set(host, forKey: Self.hostKey) }
    }
    @Published var port: Int {
        didSet { UserDefaults.standard.set(port, forKey: Self.portKey) }
    }
    @Published var token: String {
        didSet { UserDefaults.standard.set(token, forKey: Self.tokenKey) }
    }
    @Published var running = false
    @Published var autoFire = false {
        didSet { if oldValue != autoFire { autoFire ? startTimer() : stopTimer() } }
    }
    @Published private(set) var log: [String] = []

    private var timer: Timer?

    init() {
        host = UserDefaults.standard.string(forKey: Self.hostKey) ?? ""
        port = UserDefaults.standard.object(forKey: Self.portKey) as? Int ?? 9090
        token = UserDefaults.standard.string(forKey: Self.tokenKey) ?? ""
        running = LNNetInspector.shared().isRunning()
        if running {
            append("NetInspector 已随 App 启动 · ws://\(host.isEmpty ? "<未配置 IP>" : host):\(port)")
        }
        // UI 自动化 / 连续演示: 启动参数 -ni-autofire 开启自动连发
        if ProcessInfo.processInfo.arguments.contains("-ni-autofire") {
            autoFire = true
        }
        // -ni-fireall: 启动 2 秒后把每种请求形态各触发一次（自检/演示用）
        if ProcessInfo.processInfo.arguments.contains("-ni-fireall") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.fireAll()
            }
        }
    }

    /// App 启动时尽早调用（配置沿用 UserDefaults 里的上一次设置）
    nonisolated static func bootstrapInspector() {
        #if DEBUG
        let inspector = LNNetInspector.shared()
        let savedHost = UserDefaults.standard.string(forKey: hostKey) ?? ""
        let savedPort = UserDefaults.standard.object(forKey: portKey) as? Int ?? 9090
        let savedToken = UserDefaults.standard.string(forKey: tokenKey) ?? ""
        if !savedHost.isEmpty { inspector.host = savedHost }
        inspector.port = UInt(max(1, savedPort))
        if !savedToken.isEmpty { inspector.authToken = savedToken }
        inspector.start()
        if savedHost.isEmpty {
            NSLog("[NetInspector] 尚未配置 Mac IP —— 在 Demo 首页填入服务端横栏里的地址后点「应用并重启」")
        }
        #endif
    }

    // MARK: - Inspector 控制

    func restart() {
        guard !host.trimmingCharacters(in: .whitespaces).isEmpty else {
            append("⚠ 先填入 Mac IP（服务端启动横栏里打印的地址）")
            return
        }
        let inspector = LNNetInspector.shared()
        inspector.stop()
        inspector.host = host.trimmingCharacters(in: .whitespaces)
        inspector.port = UInt(max(1, port))
        inspector.authToken = token.trimmingCharacters(in: .whitespaces)
        inspector.start()
        running = inspector.isRunning()
        append("⟳ NetInspector → ws://\(inspector.host):\(port) · \(running ? "运行中" : "未启动")")
        append("  断线自动重连；断网期间事件落盘，连上后自动冲刷")
    }

    func stop() {
        LNNetInspector.shared().stop()
        running = false
        append("■ NetInspector 已停止")
    }

    // MARK: - 请求触发

    func fire(_ kind: DemoKind) {
        append("→ \(kind.rawValue)")
        Task {
            do {
                let line = try await NetworkDemo.shared.fire(kind)
                append(line)
            } catch {
                append("✗ \(error.localizedDescription)")
            }
        }
    }

    func fireAll() {
        for kind in DemoKind.allCases { fire(kind) }
    }

    private func randomFire() {
        fire(DemoKind.allCases.randomElement()!)
    }

    // MARK: - 日志

    func append(_ line: String) {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        log.append("\(formatter.string(from: Date()))  \(line)")
        if log.count > 300 { log.removeFirst(log.count - 300) }
    }

    func clearLog() { log.removeAll() }

    // MARK: - 自动连发

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.randomFire() }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }
}
