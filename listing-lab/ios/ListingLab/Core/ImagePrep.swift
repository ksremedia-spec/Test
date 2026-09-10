import Foundation
import UIKit
import UniformTypeIdentifiers

/// A photo ready for `POST /api/photos`: JPEG or PNG bytes, never HEIC.
struct PreparedImage: Sendable, Equatable {
    let data: Data
    let contentType: String
    let filename: String
}

enum ImageFormat: Equatable { case jpeg, png, heic, unknown }

enum ImagePrepError: Error, Equatable {
    case tooLarge
    case unreadable

    /// The web's per-file wording (`<name> — …`).
    var suffix: String {
        switch self {
        case .tooLarge: return "over 25MB"
        case .unreadable: return "not a photo format we can open (JPEG, PNG or iPhone HEIC)"
        }
    }
}

/// What the web does before upload, on the phone: sniff the bytes, convert
/// HEIC to JPEG at quality 0.92 with the orientation baked in and no
/// downscale, and refuse anything over 25 MiB or unreadable.
enum ImagePrep {
    static let jpegQuality: CGFloat = 0.92

    /// Magic bytes, so a HEIC renamed .jpg is caught (it killed a real job on 31 Aug 2026).
    static func sniff(_ data: Data) -> ImageFormat {
        guard data.count >= 12 else { return .unknown }
        let b = [UInt8](data.prefix(12))
        if b[0] == 0xFF, b[1] == 0xD8, b[2] == 0xFF { return .jpeg }
        if b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 { return .png }
        if b[4] == 0x66, b[5] == 0x74, b[6] == 0x79, b[7] == 0x70 {   // "ftyp"
            let brand = String(bytes: b[8..<12], encoding: .ascii) ?? ""
            if ["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "avif"].contains(brand) { return .heic }
        }
        return .unknown
    }

    static func prepare(data: Data, filename: String) throws -> PreparedImage {
        guard data.count <= Catalog.maxUploadBytes else { throw ImagePrepError.tooLarge }
        let lower = filename.lowercased()
        let namedHeic = lower.hasSuffix(".heic") || lower.hasSuffix(".heif")
        switch sniff(data) {
        case .jpeg:
            return PreparedImage(data: data, contentType: "image/jpeg", filename: filename)
        case .png:
            return PreparedImage(data: data, contentType: "image/png", filename: filename)
        case .heic:
            return try convertToJPEG(data: data, filename: jpegName(for: filename))
        case .unknown:
            // Named like a HEIC but with bytes we do not recognise: let the decoder try once.
            if namedHeic, let converted = try? convertToJPEG(data: data, filename: jpegName(for: filename)) { return converted }
            throw ImagePrepError.unreadable
        }
    }

    /// A camera capture: already a UIImage, so it only needs encoding.
    static func prepare(image: UIImage, filename: String = "photo.jpg") throws -> PreparedImage {
        try encodeJPEG(image, filename: filename)
    }

    static func jpegName(for filename: String) -> String {
        var name = filename
        for ext in [".heic", ".heif", ".HEIC", ".HEIF"] where name.hasSuffix(ext) {
            name = String(name.dropLast(ext.count))
        }
        // A HEIC that was already renamed .jpg keeps its name rather than becoming "x.jpg.jpg".
        let lower = name.lowercased()
        if lower.hasSuffix(".jpg") || lower.hasSuffix(".jpeg") { return name }
        return name + ".jpg"
    }

    private static func convertToJPEG(data: Data, filename: String) throws -> PreparedImage {
        guard let image = UIImage(data: data) else { throw ImagePrepError.unreadable }
        return try encodeJPEG(image, filename: filename)
    }

    /// Full pixel size, orientation baked in by drawing, JPEG 0.92. If the
    /// result is still over the cap, lower the quality a notch rather than
    /// resize — the server never downscales, and neither do we.
    private static func encodeJPEG(_ image: UIImage, filename: String) throws -> PreparedImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        for quality in [jpegQuality, 0.85, 0.78, 0.7] {
            let jpeg = renderer.jpegData(withCompressionQuality: quality) { _ in
                image.draw(in: CGRect(origin: .zero, size: image.size))
            }
            if jpeg.count <= Catalog.maxUploadBytes {
                return PreparedImage(data: jpeg, contentType: "image/jpeg", filename: filename)
            }
        }
        throw ImagePrepError.tooLarge
    }
}
