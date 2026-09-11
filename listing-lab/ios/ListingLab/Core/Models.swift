import Foundation

// Every shape here is quoted from docs/API.md; field names are the server's.

struct Account: Codable, Equatable, Sendable {
    let id: String
    let email: String
    let name: String?
    let company: String?
}

struct AccountResponse: Decodable, Sendable { let account: Account }
struct AppleSignInResponse: Decodable, Sendable { let account: Account; let session: String }
/// `POST /api/auth/google/exchange` — the same shape as Apple's.
struct GoogleSignInResponse: Decodable, Sendable { let account: Account; let session: String }
/// `GET /api/auth/config` — whether the server has Google sign-in configured.
struct AuthConfig: Decodable, Sendable { let google: Bool }
struct OkResponse: Decodable, Sendable { let ok: Bool }

/// The four transformations. A closed set: there is no prompt box.
enum Transformation: String, Codable, CaseIterable, Sendable, Identifiable {
    case declutter, empty, staging, twilight
    var id: String { rawValue }

    /// The customer label the app uses (`Declutter`, `Empty the room`, `Virtual staging`, `Twilight`).
    var label: String {
        switch self {
        case .declutter: return "Declutter"
        case .empty: return "Empty the room"
        case .staging: return "Virtual staging"
        case .twilight: return "Twilight"
        }
    }

    /// Client fallback only — `GET /api/credits` returns `costs` and wins.
    var fallbackCost: Int { self == .twilight ? 1 : 2 }
}

struct StatementEntry: Decodable, Identifiable, Sendable {
    let at: String
    let delta: Int
    let description: String
    var id: String { "\(at)|\(delta)|\(description)" }
}

struct CreditsResponse: Decodable, Sendable {
    let balance: Int
    let statement: [StatementEntry]
    let costs: [String: Int]
    let attemptsPerCredit: Int
}

struct Pack: Decodable, Identifiable, Sendable {
    let id: String
    let credits: Int
    let priceCents: Int
}
struct PacksResponse: Decodable, Sendable { let packs: [Pack] }

struct SceneSignals: Decodable, Sendable {
    let isExterior: Bool?
    let removableClutter: String?
    let furniture: String?
    let stageableFloor: Bool?
    let why: String?
}

/// `POST /api/photos` and `POST /api/photos/from-job` answer with this.
struct UploadedPhoto: Decodable, Sendable {
    let photoId: String
    let listingId: String?
    let filename: String?
    let signals: SceneSignals?
    let classifying: Bool?
    let offers: [String]
    let advice: [String: String]?
    let url: String
}

struct SceneResponse: Decodable, Sendable {
    let ready: Bool
    let signals: SceneSignals?
    let offers: [String]
    let advice: [String: String]?
}

struct TransformResponse: Decodable, Sendable {
    let jobId: String
    let status: String
    let balance: Int
}

enum JobStatus: String, Sendable {
    case queued, running, delivered, rejected, failed, unknown
    init(_ raw: String) { self = JobStatus(rawValue: raw) ?? .unknown }
    var isWorking: Bool { self == .queued || self == .running }
    var isReturned: Bool { self == .rejected || self == .failed }
}

/// `GET /api/jobs/:jobId`.
struct JobPoll: Decodable, Sendable {
    let jobId: String
    let status: String
    let transformation: String
    let attemptsUsed: Int?
    let attemptsAllowed: Int?
    let resultUrl: String?
    let variantUrls: [String]?
    let note: String?
    let waitingOnUpstream: Bool?
    let waitingSince: String?
    let customerMessage: String?

    var jobStatus: JobStatus { JobStatus(status) }
    var variants: [String] { variantUrls ?? [] }
}

/// One row of `GET /api/jobs`.
struct JobSummary: Codable, Identifiable, Sendable, Equatable {
    let jobId: String
    let photoId: String?
    let transformation: String
    let style: String?
    let roomType: String?
    let status: String
    let waitingOnUpstream: Bool?
    let originalUrl: String?
    let resultUrl: String?
    let variantUrls: [String]?
    let rejectUrl: String?
    /// The server's small copy for the grid (`?preview=1`), added 10 Sep 2026.
    let previewUrl: String?
    let note: String?
    let startedAt: String?
    let finishedAt: String?

    var id: String { jobId }
    var jobStatus: JobStatus { JobStatus(status) }
    var kind: Transformation? { Transformation(rawValue: transformation) }
    var variants: [String] { variantUrls ?? [] }
    /// The grid's picture: the server's small preview when it offers one,
    /// else the web's `resultUrl || originalUrl` rule (an older server).
    var thumbnailUrl: String? { previewUrl ?? resultUrl ?? originalUrl }
}
struct JobsResponse: Decodable, Sendable { let jobs: [JobSummary] }

/// `POST /api/checkout` — the hosted Stripe Checkout page to open in Safari.
struct CheckoutResponse: Decodable, Sendable { let url: String; let sessionId: String? }
struct RedeemResponse: Decodable, Sendable { let ok: Bool; let credits: Int; let balance: Int }
struct ReportResponse: Decodable, Sendable { let ok: Bool; let alreadyReported: Bool? }
struct SupportResponse: Decodable, Sendable { let sent: Bool }
struct IAPVerifyResponse: Decodable, Sendable { let ok: Bool; let granted: Int; let balance: Int; let alreadyGranted: Bool }

/// The closed lists, in the server's order (`STAGING_STYLES`, `ROOM_TYPES`).
enum Catalog {
    static let stagingStyles = ["Standard", "Modern", "Contemporary", "Coastal", "Luxury"]
    static let roomTypes = ["Living Room", "Dining Room", "Primary Bedroom", "Guest Bedroom",
                            "Nursery / Kids Room", "Basement / Rec Room", "Home Office", "Other"]
    /// Twilight is one look. There is no picker.
    static let twilightMood = "Dusk"
    static let maxUploadBytes = ImagePrep.maxBytes
    static let jobsListLimit = 60
}

/// What one transformation request needs beyond the photo.
struct JobRequest: Encodable, Sendable, Equatable {
    var photoId: String
    var transformation: String
    var style: String?
    var roomType: String?

    init(photoId: String, transformation: Transformation, style: String? = nil, roomType: String? = nil) {
        self.photoId = photoId
        self.transformation = transformation.rawValue
        switch transformation {
        case .staging:
            self.style = style ?? Catalog.stagingStyles[0]
            self.roomType = roomType ?? Catalog.roomTypes[0]
        case .twilight:
            // The web sends the one look explicitly in the single flow.
            self.style = Catalog.twilightMood
            self.roomType = nil
        default:
            self.style = nil
            self.roomType = nil
        }
    }
}

/// `credit` / `credits`, as the web pluralises.
func creditsWord(_ n: Int) -> String { n == 1 ? "\(n) credit" : "\(n) credits" }
func photosWord(_ n: Int) -> String { n == 1 ? "\(n) photo" : "\(n) photos" }

/// `$X.XX`, en-US USD, as the web formats prices.
func usd(cents: Int) -> String { usd(dollars: Double(cents) / 100) }

func usd(dollars: Double) -> String {
    let f = NumberFormatter()
    f.numberStyle = .currency
    f.locale = Locale(identifier: "en_US")
    f.currencyCode = "USD"
    return f.string(from: NSNumber(value: dollars)) ?? String(format: "$%.2f", dollars)
}

/// The server's ISO timestamps (with fractional seconds) → Date.
enum ISO {
    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }
}
