import SwiftUI
import WebKit
import UIKit

/// A board page from the site, shown as-is. The pages already know how to
/// refresh themselves; this only gives them a home and a reload button.
struct BoardWebView: UIViewRepresentable {
    let url: URL
    @Binding var reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0x0C/255, green: 0x11/255, blue: 0x18/255, alpha: 1)
        web.scrollView.backgroundColor = web.backgroundColor
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = context.coordinator
        web.load(URLRequest(url: url))
        context.coordinator.lastToken = reloadToken
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        if context.coordinator.lastToken != reloadToken {
            context.coordinator.lastToken = reloadToken
            web.reload()
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastToken = 0

        // Keep the board inside the app; anything that leaves the site
        // (a Stripe receipt, say) opens in Safari instead.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let u = action.request.url, let host = u.host, !host.hasSuffix("thelistinglab.app") {
                UIApplication.shared.open(u)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        }
    }
}

struct BoardTab: View {
    let title: String
    let path: String
    let secret: String
    @State private var reloadToken = 0

    var body: some View {
        NavigationStack {
            BoardWebView(url: Secret.url(path, secret: secret), reloadToken: $reloadToken)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { reloadToken += 1 } label: { Image(systemName: "arrow.clockwise") }
                            .accessibilityLabel("Reload")
                    }
                }
        }
    }
}
