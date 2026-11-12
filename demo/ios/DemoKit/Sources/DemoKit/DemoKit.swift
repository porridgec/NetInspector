//
//  DemoKit.swift
//  DemoKit
//
//  模拟典型 SPM 包的网络层：长寿 URLSession 单例。
//  NetInspector 的 hook 在 +load 即注入 protocolClasses，
//  因此即使在 -start 之前创建的 session 也能被拦截。
//

import Foundation

public enum DemoKit {

    /// 包内最常见的形态：static let 长寿单例，首次触达即固化配置。
    /// Demo 在 App 启动时（NetInspector -start 之前）就 warmup 它，
    /// 用于验证"早于 -start 创建的 session"也能被抓到。
    public static let earlySession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 15
        config.httpAdditionalHeaders = ["X-From-Package": "DemoKit-early"]
        return URLSession(configuration: config)
    }()

    /// 调用时才创建的 ephemeral session（另一种常见形态）。
    public static func makeEphemeralSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpAdditionalHeaders = ["X-From-Package": "DemoKit-ephemeral"]
        return URLSession(configuration: config)
    }

    /// 在 App 极早期调用（早于 NetInspector -start），让 session 配置先行固化。
    public static func warmup() {
        _ = earlySession
    }

    /// 用包内早建 session 发起请求
    @discardableResult
    public static func fetchViaEarlySession() async throws -> String {
        try await get("https://httpbin.org/get?src=spm-early-session", session: earlySession)
    }

    /// 用新建 ephemeral session 发起请求
    @discardableResult
    public static func fetchViaEphemeralSession() async throws -> String {
        let session = makeEphemeralSession()
        defer { session.finishTasksAndInvalidate() }
        return try await get("https://httpbin.org/get?src=spm-ephemeral-session", session: session)
    }

    private static func get(_ urlString: String, session: URLSession) async throws -> String {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        let started = Date()
        let (data, response) = try await session.data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        let ms = Int(-started.timeIntervalSinceNow * 1000)
        return "✓ [SPM] \(status) · \(ms) ms · \(data.count) B"
    }
}
