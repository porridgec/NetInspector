//
//  ContentView.swift
//  DemoApp
//

import SwiftUI

struct ContentView: View {
    @EnvironmentObject var store: DemoStore

    var body: some View {
        NavigationView {
            Form {
                serverSection
                requestSection
                logSection
            }
            .navigationTitle("NetInspector Demo")
            .navigationBarTitleDisplayMode(.inline)
        }
        .navigationViewStyle(.stack)
    }

    private var serverSection: some View {
        Section {
            TextField("Mac IP（服务端横栏地址，如 192.168.0.153）", text: $store.host)
                .keyboardType(.decimalPad)
                .autocorrectionDisabled()
                .font(.system(.footnote).monospaced())
            Stepper("端口 \(store.port)", value: $store.port, in: 1024...65535)
            HStack {
                Button("应用并重启") { store.restart() }
                    .buttonStyle(.borderedProminent)
                if store.running {
                    Button("停止") { store.stop() }
                        .buttonStyle(.bordered)
                        .tint(.red)
                }
                Spacer()
                Circle()
                    .fill(store.running ? Color.green : Color.gray)
                    .frame(width: 10, height: 10)
                Text(store.running ? "运行中" : "未启动")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Toggle("自动连发（每 3 秒随机请求）", isOn: $store.autoFire)
            Text("① Mac: cd server && npm start  ② 把横栏 IP 填到上面  ③ 浏览器打开 http://<ip>:9090")
                .font(.caption2)
                .foregroundColor(.secondary)
        } header: {
            Text("Mac 服务端")
        } footer: {
            Text("Dashboard 里应能看到下面按钮触发的所有请求")
        }
    }

    private var requestSection: some View {
        Section("触发请求（覆盖不同请求形态）") {
            ForEach(DemoKind.allCases) { kind in
                Button {
                    store.fire(kind)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(kind.rawValue)
                            .font(.subheadline.weight(.medium))
                        Text(kind.subtitle)
                            .font(.caption2)
                            .foregroundColor(.secondary)
                    }
                }
            }
            Button {
                store.fireAll()
            } label: {
                Text("🔥 全部来一发")
                    .font(.subheadline.weight(.semibold))
            }
        }
    }

    private var logSection: some View {
        Section {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(store.log.enumerated()), id: \.offset) { _, line in
                        Text(line)
                            .font(.system(size: 11).monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .foregroundColor(line.hasPrefix("→") ? .secondary : (line.contains("✗") ? .red : .primary))
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(minHeight: 160, maxHeight: 280)
        } header: {
            HStack {
                Text("App 日志")
                Spacer()
                Button("清空") { store.clearLog() }
                    .font(.caption)
            }
        } footer: {
            Text("详细请求/响应内容请看 Mac 端 Dashboard")
        }
    }
}
