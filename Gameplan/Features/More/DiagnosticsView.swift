import SwiftUI
import UIKit

/// Shows what each data source actually returned.
///
/// The feeds this app reads are undocumented, so the most useful thing when
/// something looks wrong is not an error message — it is the first few hundred
/// characters of the real response. This puts those on screen and lets you copy
/// the lot, so a problem can be diagnosed from the actual payload.
@MainActor
struct DiagnosticsView: View {
    @State private var entries: [DiagnosticsEntry] = []
    @State private var didCopy = false

    var body: some View {
        List {
            Section {
                Button {
                    copyReport()
                } label: {
                    Label(didCopy ? "Copied" : "Copy full report", systemImage: didCopy ? "checkmark" : "doc.on.doc")
                }
                Button("Clear", role: .destructive) {
                    Task {
                        await DiagnosticsLog.shared.clear()
                        await reload()
                    }
                }
            } footer: {
                Text("Requests are recorded with the response body but never with headers, cookies or session details. Copy this and share it if something isn't loading correctly.")
            }

            if entries.isEmpty {
                Section {
                    Text("No requests recorded yet. Pull to refresh on the Game Plan tab, then come back.")
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(entries) { entry in
                Section {
                    LabeledContent("Status", value: entry.statusCode.map(String.init) ?? "No response")
                    LabeledContent("Size", value: "\(entry.byteCount) bytes")
                    LabeledContent("When", value: entry.timestamp.formatted(date: .omitted, time: .standard))

                    DisclosureGroup("Response") {
                        Text(entry.sample.isEmpty ? "(empty)" : entry.sample)
                            .font(.system(.caption2, design: .monospaced))
                            .textSelection(.enabled)
                            .foregroundStyle(.secondary)
                    }

                    Text(entry.url)
                        .font(.system(.caption2, design: .monospaced))
                        .foregroundStyle(.tertiary)
                        .textSelection(.enabled)
                } header: {
                    HStack {
                        Text(entry.label)
                        Spacer()
                        Text(entry.isFailure ? "Failed" : "OK")
                            .foregroundStyle(entry.isFailure ? Theme.Palette.negative : Theme.Palette.positive)
                    }
                } footer: {
                    if entry.isFailure {
                        Text(entry.outcome)
                            .foregroundStyle(Theme.Palette.negative)
                    }
                }
            }
        }
        .navigationTitle("Diagnostics")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await reload() }
    }

    private func reload() async {
        entries = await DiagnosticsLog.shared.all()
    }

    private func copyReport() {
        Task {
            let report = await DiagnosticsLog.shared.report()
            UIPasteboard.general.string = report
            didCopy = true
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            didCopy = false
        }
    }
}
