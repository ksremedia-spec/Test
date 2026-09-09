import XCTest
import UIKit
import ImageIO
import UniformTypeIdentifiers
@testable import ListingLab

/// HEIC → JPEG on the phone, the way the web does it in the browser: the
/// bytes are sniffed, the orientation is baked in, nothing is downscaled.
final class ImagePrepTests: XCTestCase {
    private func image(width: Int, height: Int) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: {
            let f = UIGraphicsImageRendererFormat.default(); f.scale = 1; return f }()).image { ctx in
            UIColor.systemBlue.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
            UIColor.white.setFill(); ctx.fill(CGRect(x: 0, y: 0, width: width / 2, height: height / 2))
        }
    }

    /// Encodes a HEIC with an EXIF orientation tag, as an iPhone would.
    private func heic(_ ui: UIImage, orientation: CGImagePropertyOrientation = .up) throws -> Data {
        guard let cg = ui.cgImage else { throw XCTSkip("no CGImage") }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.heic.identifier as CFString, 1, nil) else {
            throw XCTSkip("This simulator cannot encode HEIC")
        }
        CGImageDestinationAddImage(dest, cg, [kCGImagePropertyOrientation: orientation.rawValue] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw XCTSkip("This simulator cannot encode HEIC") }
        return out as Data
    }

    func testSniffsByBytesNotByName() throws {
        let png = image(width: 8, height: 6).pngData()!
        let jpeg = image(width: 8, height: 6).jpegData(compressionQuality: 0.9)!
        XCTAssertEqual(ImagePrep.sniff(png), .png)
        XCTAssertEqual(ImagePrep.sniff(jpeg), .jpeg)
        XCTAssertEqual(ImagePrep.sniff(Data("not a photo at all, really".utf8)), .unknown)
        XCTAssertEqual(ImagePrep.sniff(try heic(image(width: 8, height: 6))), .heic)
    }

    func testJPEGAndPNGPassThroughUntouched() throws {
        let jpeg = image(width: 8, height: 6).jpegData(compressionQuality: 0.9)!
        let p = try ImagePrep.prepare(data: jpeg, filename: "IMG_1.jpg")
        XCTAssertEqual(p.data, jpeg)
        XCTAssertEqual(p.contentType, "image/jpeg")
        XCTAssertEqual(p.filename, "IMG_1.jpg")
        let png = image(width: 8, height: 6).pngData()!
        XCTAssertEqual(try ImagePrep.prepare(data: png, filename: "a.png").contentType, "image/png")
    }

    func testHEICBecomesFullSizeJPEGWithOrientationBakedIn() throws {
        // A HEIC renamed .jpg (the 31 Aug 2026 bug) is caught by its bytes.
        let data = try heic(image(width: 40, height: 30), orientation: .right)
        let p = try ImagePrep.prepare(data: data, filename: "renamed.jpg")
        XCTAssertEqual(ImagePrep.sniff(p.data), .jpeg)
        XCTAssertEqual(p.contentType, "image/jpeg")
        XCTAssertEqual(p.filename, "renamed.jpg")
        let out = UIImage(data: p.data)!
        XCTAssertEqual(out.imageOrientation, .up, "the orientation tag is gone")
        XCTAssertEqual(Int(out.size.width), 30, "and the pixels were rotated instead")
        XCTAssertEqual(Int(out.size.height), 40)

        let named = try ImagePrep.prepare(data: try heic(image(width: 40, height: 30)), filename: "IMG_2.HEIC")
        XCTAssertEqual(named.filename, "IMG_2.jpg")
        XCTAssertEqual(ImagePrep.jpegName(for: "photo.heif"), "photo.jpg")
    }

    func testRefusesWhatItCannotUse() {
        XCTAssertThrowsError(try ImagePrep.prepare(data: Data("definitely not an image".utf8), filename: "x.jpg")) { e in
            XCTAssertEqual(e as? ImagePrepError, .unreadable)
        }
        var big = image(width: 8, height: 6).jpegData(compressionQuality: 0.9)!
        big.append(Data(count: Catalog.maxUploadBytes))
        XCTAssertThrowsError(try ImagePrep.prepare(data: big, filename: "huge.jpg")) { e in
            XCTAssertEqual(e as? ImagePrepError, .tooLarge)
        }
        XCTAssertEqual(ImagePrepError.tooLarge.suffix, "over 25MB")
    }

    func testCameraCaptureIsEncodedTheSameWay() throws {
        let p = try ImagePrep.prepare(image: image(width: 20, height: 10))
        XCTAssertEqual(ImagePrep.sniff(p.data), .jpeg)
        XCTAssertEqual(p.filename, "photo.jpg")
        XCTAssertEqual(UIImage(data: p.data)!.size, CGSize(width: 20, height: 10))
    }
}
