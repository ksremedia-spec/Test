import SwiftUI

/// The single toast: bottom-centre, dark on warm paper, 3.2 seconds.
struct ToastOverlay: ViewModifier {
    @Environment(AppSession.self) private var session

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let message = session.toasts.message {
                Text(message)
                    .font(Theme.ui(14))
                    .foregroundStyle(Color(hex: 0xF2EDE6))
                    .multilineTextAlignment(.center)
                    .padding(EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14))
                    .background(Color(hex: 0x1C1D1C), in: RoundedRectangle(cornerRadius: 9))
                    .frame(maxWidth: 360)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 26)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeInOut(duration: 0.3), value: session.toasts.message)
    }
}

extension View {
    func toastOverlay() -> some View { modifier(ToastOverlay()) }
}
