//
//  NetworkDemo.swift
//  DemoApp
//
//  每个用例刻意使用不同的 URLSession 形态，验证全部会被拦截：
//    - URLSession.shared            （全局 registerClass 覆盖）
//    - .default / .ephemeral 配置    （SessionConfiguration swizzle 覆盖）
//    - uploadTask multipart         （HTTPBodyStream 流式缓冲路径）
//

import Foundation

enum DemoKind: String, CaseIterable, Identifiable {
    case getJSON = "GET JSON"
    case postJSON = "POST JSON"
    case postForm = "POST 表单 (urlencoded)"
    case postMultipart = "POST multipart (带 JPEG 文件)"
    case getImage = "GET 图片 (二进制响应)"
    case status404 = "GET 404"
    case redirect = "GET 重定向 ×3"
    case slow = "GET 慢请求 (4s)"
    case connError = "GET 不可达主机 (报错)"

    var id: String { rawValue }

    var subtitle: String {
        switch self {
        case .getJSON: return "URLSession.shared · jsonplaceholder"
        case .postJSON: return "default 配置 · httpbin echo"
        case .postForm: return "ephemeral 配置"
        case .postMultipart: return "uploadTask · 流式 body"
        case .getImage: return "ephemeral 配置 · PNG 回显"
        case .status404: return "default 配置"
        case .redirect: return "302 链 · 每跳单独记录"
        case .slow: return "ephemeral 配置"
        case .connError: return "TEST-NET 地址 · 超时报错"
        }
    }
}

final class NetworkDemo: @unchecked Sendable {
    static let shared = NetworkDemo()

    private let defaultSession = URLSession(configuration: .default)
    private let ephemeralSession = URLSession(configuration: .ephemeral)
    private lazy var errorSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        return URLSession(configuration: config)
    }()

    private lazy var jpegData: Data = {
        Data(base64Encoded: DemoAssets.realJpegBase64) ?? Data([0xFF, 0xD8, 0xFF, 0xE0])
    }()

    func fire(_ kind: DemoKind) async throws -> String {
        switch kind {
        case .getJSON: return try await get("https://jsonplaceholder.typicode.com/users/1", session: .shared)
        case .postJSON: return try await postJSON()
        case .postForm: return try await postForm()
        case .postMultipart: return try await postMultipart()
        case .getImage: return try await get("https://httpbin.org/image/png", session: ephemeralSession)
        case .status404: return try await get("https://httpbin.org/status/404", session: defaultSession)
        case .redirect: return try await get("https://httpbin.org/redirect/3", session: defaultSession)
        case .slow: return try await get("https://httpbin.org/delay/4", session: ephemeralSession)
        case .connError: return try await get("https://192.0.2.1/unreachable", session: errorSession)
        }
    }

    // MARK: - 用例

    private func get(_ urlString: String, session: URLSession) async throws -> String {
        guard let url = URL(string: urlString) else { throw URLError(.badURL) }
        let started = Date()
        let (data, response) = try await session.data(from: url)
        return Self.summary(data: data, response: response, started: started)
    }

    private func postJSON() async throws -> String {
        var request = URLRequest(url: URL(string: "https://httpbin.org/post")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("NetInspector-Demo/1.0", forHTTPHeaderField: "User-Agent")
        let body: [String: Any] = [
            "name": "NetInspector",
            "purpose": "dashboard demo",
            "nested": ["platform": "iOS", "year": 2026, "tags": ["debug", "lan"]],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let started = Date()
        let (data, response) = try await defaultSession.data(for: request)
        return Self.summary(data: data, response: response, started: started)
    }

    private func postForm() async throws -> String {
        var request = URLRequest(url: URL(string: "https://httpbin.org/post")!)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let form = "title=Hello%20NetInspector&content=%E4%B8%AD%E6%96%87%E8%A1%A8%E5%8D%95%E5%86%85%E5%AE%B9&rate=5"
        request.httpBody = Data(form.utf8)

        let started = Date()
        let (data, response) = try await ephemeralSession.data(for: request)
        return Self.summary(data: data, response: response, started: started)
    }

    private func postMultipart() async throws -> String {
        var request = URLRequest(url: URL(string: "https://httpbin.org/post")!)
        request.httpMethod = "POST"
        let boundary = "----NetInspectorDemo-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nMonthly report\r\n".utf8))
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"tags\"\r\n\r\n[\"demo\",\"multipart\"]\r\n".utf8))
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"attachment\"; filename=\"chart.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
        body.append(jpegData)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))

        // uploadTask 走 HTTPBodyStream 路径 —— 验证流式 body 缓冲/落盘逻辑
        let started = Date()
        let (data, response) = try await defaultSession.upload(for: request, from: body)
        return Self.summary(data: data, response: response, started: started)
    }

    // MARK: - 汇总

    private static func summary(data: Data, response: URLResponse, started: Date) -> String {
        let ms = Int(-started.timeIntervalSinceNow * 1000)
        let status = (response as? HTTPURLResponse)?.statusCode ?? -1
        let size = ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
        return "✓ \(status) · \(ms) ms · \(size)"
    }
}
