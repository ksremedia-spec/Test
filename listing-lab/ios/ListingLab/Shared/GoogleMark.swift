import SwiftUI

/// The Google "G" on the Continue with Google button, drawn from the same
/// four paths as the website's button (a 48×48 box) so it is crisp at any size.
struct GoogleMark: View {
    static let paths: [(d: String, color: Color)] = [
        ("M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z", Color(hex: 0xEA4335)),
        ("M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z", Color(hex: 0x4285F4)),
        ("M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z", Color(hex: 0xFBBC05)),
        ("M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z", Color(hex: 0x34A853)),
    ]

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 48
            let transform = CGAffineTransform(scaleX: scale, y: scale)
            for entry in Self.paths {
                context.fill(SVGPath.path(entry.d).applying(transform), with: .color(entry.color))
            }
        }
    }
}

/// Just enough of the SVG path grammar for the mark above: M, L, H, V, C, S
/// and Z, absolute and relative, with the implicit repeats SVG allows.
enum SVGPath {
    private enum Token { case command(Character), number(CGFloat) }

    static func path(_ d: String) -> Path {
        let tokens = tokenize(d)
        var path = Path()
        var i = 0
        var current = CGPoint.zero
        var subpathStart = CGPoint.zero
        var lastControl: CGPoint?
        var command: Character = "M"

        func next() -> CGFloat {
            guard i < tokens.count, case .number(let value) = tokens[i] else { return 0 }
            i += 1
            return value
        }
        func point(relativeTo origin: CGPoint) -> CGPoint {
            let x = next(), y = next()
            return CGPoint(x: origin.x + x, y: origin.y + y)
        }

        while i < tokens.count {
            if case .command(let c) = tokens[i] {
                command = c
                i += 1
                if command == "Z" || command == "z" {
                    path.closeSubpath()
                    current = subpathStart
                    lastControl = nil
                    continue
                }
            }
            let relative = command.isLowercase
            let origin = relative ? current : .zero
            switch command.uppercased() {
            case "M":
                current = point(relativeTo: origin)
                subpathStart = current
                path.move(to: current)
                lastControl = nil
                command = relative ? "l" : "L"   // further pairs are lines
            case "L":
                current = point(relativeTo: origin)
                path.addLine(to: current)
                lastControl = nil
            case "H":
                current.x = (relative ? current.x : 0) + next()
                path.addLine(to: current)
                lastControl = nil
            case "V":
                current.y = (relative ? current.y : 0) + next()
                path.addLine(to: current)
                lastControl = nil
            case "C":
                let c1 = point(relativeTo: origin), c2 = point(relativeTo: origin), end = point(relativeTo: origin)
                path.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2
                current = end
            case "S":
                let c1 = lastControl.map { CGPoint(x: 2 * current.x - $0.x, y: 2 * current.y - $0.y) } ?? current
                let c2 = point(relativeTo: origin), end = point(relativeTo: origin)
                path.addCurve(to: end, control1: c1, control2: c2)
                lastControl = c2
                current = end
            default:
                i += 1   // a command this parser does not know: skip its token
            }
        }
        return path
    }

    /// Splits "M24 9.5c3.54 0-6.85-.15z" into commands and numbers. A minus
    /// or a second decimal point starts a new number, as SVG allows.
    private static func tokenize(_ d: String) -> [Token] {
        var tokens: [Token] = []
        var number = ""
        func flush() {
            if let value = Double(number) { tokens.append(.number(CGFloat(value))) }
            number = ""
        }
        for ch in d {
            if ch.isLetter {
                flush()
                tokens.append(.command(ch))
            } else if ch == "-" {
                if !number.isEmpty, number.last != "e" { flush() }
                number.append(ch)
            } else if ch == "." {
                if number.contains(".") { flush() }
                number.append(ch)
            } else if ch.isNumber || ch == "e" {
                number.append(ch)
            } else {
                flush()   // space or comma
            }
        }
        flush()
        return tokens
    }
}
