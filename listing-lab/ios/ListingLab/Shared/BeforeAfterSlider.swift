import SwiftUI

/// The before/after compare. The RESULT is the base layer; the ORIGINAL is
/// clipped on top from the left edge, so the left of the split is always the
/// original and the right is always the finished photo — the order every
/// agent expects. Press anywhere to jump the split and drag to move it.
struct BeforeAfterSlider: View {
    let before: UIImage?
    let after: UIImage
    /// A fresh delivery: the original is on screen first and the result
    /// wipes across it, with a tap when it lands, before the slider settles
    /// at the middle. A revisit from the library skips the show.
    var reveal = false
    @State private var split: CGFloat = 0.5
    @State private var revealed = false

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            ZStack(alignment: .topLeading) {
                Image(uiImage: after)
                    .resizable()
                    .scaledToFill()
                    .frame(width: width, height: geo.size.height)
                    .clipped()
                if let before {
                    Image(uiImage: before)
                        .resizable()
                        .scaledToFill()
                        .frame(width: width, height: geo.size.height)
                        .clipped()
                        .mask(alignment: .leading) {
                            Rectangle().frame(width: width * split)
                        }
                    // Handle: a 2px white line with a 38px round knob.
                    Rectangle()
                        .fill(.white)
                        .frame(width: 2, height: geo.size.height)
                        .shadow(color: .black.opacity(0.5), radius: 0, x: 1, y: 0)
                        .offset(x: width * split - 1)
                    Circle()
                        .fill(.white)
                        .frame(width: 38, height: 38)
                        .overlay(Text("↔").font(.system(size: 13, weight: .bold)).foregroundStyle(Theme.bg))
                        .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
                        .position(x: width * split, y: geo.size.height / 2)
                    tag("ORIGINAL").padding(8)
                    tag("RESULT").padding(8).frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard before != nil, width > 0 else { return }
                        split = min(1, max(0, value.location.x / width))
                    }
            )
        }
        .aspectRatio(after.size.width / max(after.size.height, 1), contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: Theme.rMd))
        .onAppear {
            guard reveal, before != nil, !revealed else { return }
            revealed = true
            split = 1
            Task {
                try? await Task.sleep(for: .seconds(0.5))
                withAnimation(.easeInOut(duration: 1.5)) { split = 0 }
                try? await Task.sleep(for: .seconds(1.5))
                Haptics.success()
                try? await Task.sleep(for: .seconds(0.6))
                withAnimation(.easeInOut(duration: 0.6)) { split = 0.5 }
            }
        }
        .accessibilityLabel(before == nil ? "The finished result" : "Original on the left, result on the right")
    }

    private func tag(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 10.5, weight: .bold))
            .kerning(1.2)
            .foregroundStyle(Color(hex: 0xF2F5F9))
            .padding(EdgeInsets(top: 4, leading: 7, bottom: 4, trailing: 7))
            .background(Color(red: 9/255, green: 13/255, blue: 19/255).opacity(0.72), in: RoundedRectangle(cornerRadius: 4))
    }
}
