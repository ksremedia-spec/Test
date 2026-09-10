import SwiftUI

/// The studio register — the dark palette the web app uses, token for token
/// (`web/app.html` `:root`, quoted in `assets/brand.md`). The app is dark,
/// always. Names are the web's roles: `pine` is the accent, `brass` the
/// secondary — the colours themselves are Horizon Home Media's azure blue.
enum Theme {
    // Studio surfaces and text.
    static let bg = Color(hex: 0x0C1118)
    static let surface = Color(hex: 0x131A24)
    static let surface2 = Color(hex: 0x19222E)
    static let surface3 = Color(hex: 0x1F2938)
    static let line = Color(hex: 0x293546)
    static let text = Color(hex: 0xE9EDF3)
    static let textSoft = Color(hex: 0xA0ABBA)
    static let textFaint = Color(hex: 0x6B7787)

    // Brand.
    static let pine = Color(hex: 0x4E8FD0)
    static let pineBright = Color(hex: 0x66A2DE)
    static let pineDeep = Color(hex: 0x14304F)
    static let brass = Color(hex: 0x8FBEE8)
    static let brassSoft = Color(hex: 0xC9DFF2)
    static let paper = Color(hex: 0x0F141B)
    /// Text on a primary button: near-black on blue.
    static let onPine = Color(hex: 0x08131F)

    // States.
    static let ok = Color(hex: 0x46B98A)
    static let warn = Color(hex: 0xD9A441)
    static let bad = Color(hex: 0xE2615A)
    static let readyBadge = Color(hex: 0x5ECD96)
    static let workingBadge = Color(hex: 0x8FBEE8)
    static let returnedBadge = Color(hex: 0xE08A8A)
    static let errorText = Color(hex: 0xF3B4B0)
    static let noteText = Color(hex: 0x9FE0C6)

    // Radii, from the web's --r-* tokens.
    static let rSm: CGFloat = 6
    static let rMd: CGFloat = 10
    static let rLg: CGFloat = 18

    /// Display type: Fraunces, bundled (OFL). Scales with Dynamic Type through
    /// the text style it is relative to.
    static func display(_ size: CGFloat, weight: Font.Weight = .semibold, relativeTo style: Font.TextStyle = .title2, italic: Bool = false) -> Font {
        let name: String
        switch (weight, italic) {
        case (.bold, _): name = "Fraunces-Bold"
        case (.semibold, true): name = "Fraunces-SemiBoldItalic"
        case (.semibold, false): name = "Fraunces-SemiBold"
        case (.medium, true): name = "Fraunces-MediumItalic"
        case (.medium, false): name = "Fraunces-Medium"
        case (_, true): name = "Fraunces-Italic"
        default: name = "Fraunces-Regular"
        }
        return .custom(name, size: size, relativeTo: style)
    }

    /// UI type: the system font (SF), sized from the web's pixel sizes and
    /// scaled with Dynamic Type through the nearest text style.
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let style: Font.TextStyle
        switch size {
        case ..<11.5: style = .caption2
        case ..<12.75: style = .caption
        case ..<13.75: style = .footnote
        case ..<15.25: style = .subheadline
        case ..<16.5: style = .body
        case ..<18: style = .headline
        default: style = .title3
        }
        return .system(style, design: .default, weight: weight)
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

// MARK: - Building blocks that match the web's CSS

/// `.btn` — full width, blue, near-black text, min-height 50.
struct PrimaryButtonStyle: ButtonStyle {
    var small = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.ui(small ? 14 : 15.5, weight: .bold))
            .foregroundStyle(Theme.onPine)
            .frame(maxWidth: small ? nil : .infinity, minHeight: small ? 40 : 50)
            .padding(.horizontal, small ? 14 : 18)
            .background(Theme.pine, in: RoundedRectangle(cornerRadius: Theme.rSm))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// The website's `#googleBtn` — white, near-black text, radius 10, 600 15px.
struct GoogleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.ui(15, weight: .semibold))
            .foregroundStyle(Color(hex: 0x1F1F1F))
            .frame(maxWidth: .infinity, minHeight: 50)
            .padding(.horizontal, 18)
            .background(Color.white, in: RoundedRectangle(cornerRadius: Theme.rMd))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// `.btn.ghost` — transparent with a 1px line border.
struct GhostButtonStyle: ButtonStyle {
    var small = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.ui(small ? 14 : 15.5, weight: .semibold))
            .foregroundStyle(Theme.text)
            .frame(maxWidth: small ? nil : .infinity, minHeight: small ? 40 : 50)
            .padding(.horizontal, small ? 14 : 18)
            .background(
                RoundedRectangle(cornerRadius: Theme.rSm)
                    .stroke(configuration.isPressed ? Theme.pine : Theme.line, lineWidth: 1)
            )
    }
}

/// `.linkbtn` — quiet, faint, link-like.
struct LinkButtonStyle: ButtonStyle {
    var color: Color = Theme.textFaint
    var size: CGFloat = 13
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.ui(size))
            .foregroundStyle(color)
            .padding(6)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

extension View {
    /// Disabled buttons on the web sit at opacity .5.
    func dimmedWhenDisabled(_ disabled: Bool) -> some View {
        opacity(disabled ? 0.5 : 1).disabled(disabled)
    }

    /// `.card` — surface, 1px line, radius 10, padding 20.
    func card() -> some View {
        padding(20)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.rMd))
            .overlay(RoundedRectangle(cornerRadius: Theme.rMd).stroke(Theme.line, lineWidth: 1))
    }

    /// The web's text input look: surface-2, 1px line, radius 6, 12/13 padding.
    func fieldChrome() -> some View {
        padding(EdgeInsets(top: 12, leading: 13, bottom: 12, trailing: 13))
            .background(Theme.surface2, in: RoundedRectangle(cornerRadius: Theme.rSm))
            .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.line, lineWidth: 1))
    }
}

/// A field label: 12px, 600, uppercase, letter-spaced, faint.
struct FieldLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(Theme.ui(12, weight: .semibold))
            .kerning(1.2)
            .foregroundStyle(Theme.textFaint)
    }
}

/// `.err` — the red error box.
struct ErrorBox: View {
    let message: String
    var body: some View {
        Text(message)
            .font(Theme.ui(14))
            .foregroundStyle(Theme.errorText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: 11, leading: 13, bottom: 11, trailing: 13))
            .background(Theme.bad.opacity(0.10), in: RoundedRectangle(cornerRadius: Theme.rSm))
            .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.bad.opacity(0.35), lineWidth: 1))
    }
}

/// `.note` — the green info box.
struct NoteBox<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .font(Theme.ui(14))
            .foregroundStyle(Theme.noteText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(EdgeInsets(top: 11, leading: 13, bottom: 11, trailing: 13))
            .background(Theme.ok.opacity(0.09), in: RoundedRectangle(cornerRadius: Theme.rSm))
            .overlay(RoundedRectangle(cornerRadius: Theme.rSm).stroke(Theme.ok.opacity(0.32), lineWidth: 1))
    }
}

/// The wordmark: Fraunces 700, LISTING in ink and LAB in the accent.
struct Wordmark: View {
    var size: CGFloat = 22
    var body: some View {
        HStack(spacing: 8) {
            Image("LaunchMark")
                .resizable()
                .scaledToFit()
                .frame(width: 36, height: 36)
            (Text("LISTING ").foregroundStyle(Theme.text) + Text("LAB").foregroundStyle(Theme.pine))
                .font(Theme.display(size, weight: .bold, relativeTo: .title2))
        }
        .accessibilityLabel("Listing Lab")
    }
}

/// The 15px spinner the primary button shows while a request is in flight.
struct ButtonSpinner: View {
    var body: some View {
        ProgressView().tint(Theme.onPine).controlSize(.small)
    }
}
