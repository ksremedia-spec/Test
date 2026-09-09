import XCTest
@testable import ListingLab

/// The API client's decoding, against the shapes quoted in docs/API.md.
final class DecodingTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    func testCreditsResponse() throws {
        let json = """
        { "balance": 12,
          "statement": [
            { "at": "2026-09-09T14:02:11.123Z", "delta": -2, "description": "Virtual Staging started" },
            { "at": "2026-09-08T10:00:00.000Z", "delta": 10, "description": "Bought 10 credits" } ],
          "costs": { "declutter": 2, "empty": 2, "twilight": 1, "staging": 2 },
          "attemptsPerCredit": 3 }
        """
        let c = try decode(CreditsResponse.self, json)
        XCTAssertEqual(c.balance, 12)
        XCTAssertEqual(c.statement.count, 2)
        XCTAssertEqual(c.statement[0].delta, -2)
        XCTAssertEqual(c.costs["twilight"], 1)
        XCTAssertEqual(c.attemptsPerCredit, 3)
        XCTAssertNotNil(ISO.date(c.statement[0].at), "fractional-second timestamps parse")
        XCTAssertNotNil(ISO.date("2026-09-09T14:02:11Z"), "and whole-second ones")
    }

    @MainActor func testUploadAndScene() throws {
        let up = try decode(UploadedPhoto.self, """
        { "photoId": "pho_abc", "listingId": "lst_1", "filename": "photo.jpg", "signals": null,
          "classifying": true, "offers": ["declutter","empty","staging","twilight"], "advice": {},
          "url": "/api/photos/acct_1%2Fpho_abc%2Foriginal" }
        """)
        XCTAssertEqual(up.photoId, "pho_abc")
        XCTAssertEqual(up.offers.count, 4)
        XCTAssertNil(up.signals)

        let scene = try decode(SceneResponse.self, """
        { "ready": true,
          "signals": { "isExterior": false, "removableClutter": "some", "furniture": "furnished", "stageableFloor": true, "why": "living room" },
          "offers": ["declutter", "empty"],
          "advice": { "declutter": "There is not much here to remove — expect a small change." } }
        """)
        XCTAssertTrue(scene.ready)
        XCTAssertEqual(scene.signals?.removableClutter, "some")
        let item = BatchItem(name: "photo.jpg", preview: nil, photo: up)
        XCTAssertEqual(item.offers, Transformation.allCases)
        XCTAssertTrue(item.classifying)
        item.apply(scene)
        XCTAssertEqual(item.offers, [.declutter, .empty], "offers narrow in the server's order")
        XCTAssertEqual(item.advice[.declutter], "There is not much here to remove — expect a small change.")
        XCTAssertFalse(item.classifying)
    }

    func testJobPollAndList() throws {
        let poll = try decode(JobPoll.self, """
        { "jobId": "job_1", "status": "running", "transformation": "staging", "attemptsUsed": 0, "attemptsAllowed": 3,
          "resultUrl": null, "variantUrls": [], "note": null, "waitingOnUpstream": true, "waitingSince": "2026-09-09T14:02:11.123Z",
          "customerMessage": "High demand right now." }
        """)
        XCTAssertEqual(poll.jobStatus, .running)
        XCTAssertTrue(poll.jobStatus.isWorking)
        XCTAssertEqual(poll.waitingOnUpstream, true)
        XCTAssertEqual(poll.variants, [])

        let list = try decode(JobsResponse.self, """
        { "jobs": [ {
            "jobId": "job_2", "photoId": "pho_2", "transformation": "empty", "style": null, "roomType": null,
            "status": "delivered", "waitingOnUpstream": false,
            "originalUrl": "/api/photos/acct_1%2Fpho_2%2Foriginal",
            "resultUrl": "/api/photos/acct_1%2Fpho_2%2Fjob_2-result.jpg",
            "variantUrls": ["/api/photos/acct_1%2Fpho_2%2Fjob_2-result-v2.jpg"], "rejectUrl": null, "note": null,
            "startedAt": "2026-09-09T14:02:11.123Z", "finishedAt": "2026-09-09T14:05:40.001Z" },
          { "jobId": "job_3", "photoId": "pho_3", "transformation": "declutter", "status": "rejected",
            "originalUrl": null, "resultUrl": null, "rejectUrl": "/api/photos/x", "note": "Too full.", "startedAt": "2026-09-09T14:00:00.000Z", "finishedAt": null } ] }
        """)
        XCTAssertEqual(list.jobs.count, 2)
        XCTAssertEqual(list.jobs[0].kind, .empty)
        XCTAssertEqual(list.jobs[0].variants.count, 1)
        XCTAssertEqual(list.jobs[0].thumbnailUrl, "/api/photos/acct_1%2Fpho_2%2Fjob_2-result.jpg")
        XCTAssertEqual(list.jobs[1].jobStatus, .rejected)
        XCTAssertNil(list.jobs[1].thumbnailUrl, "a returned job with no original has nothing to show")
        XCTAssertEqual(JobStatus("something-new"), .unknown, "an unknown status never crashes the grid")
    }

    func testErrorShapeAndSessionCookie() {
        let err = APIClient.serverError(Data("""
        { "error": { "code": "INSUFFICIENT_CREDITS", "message": "Not enough credits for this transformation." } }
        """.utf8), status: 402)
        XCTAssertEqual(err, .server(status: 402, code: "INSUFFICIENT_CREDITS", message: "Not enough credits for this transformation."))
        XCTAssertEqual(err.code, "INSUFFICIENT_CREDITS")
        XCTAssertFalse(err.isRetryable)
        XCTAssertTrue(APIError.timeout.isRetryable)
        XCTAssertEqual(APIError.timeout.message, "That took too long — check your signal and try again.")

        let token = String(repeating: "ab", count: 32)
        let response = HTTPURLResponse(url: APIClient.baseURL.appendingPathComponent("api/signin"), statusCode: 200, httpVersion: nil,
                                       headerFields: ["Set-Cookie": "ll_session=\(token); Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure"])!
        XCTAssertEqual(APIClient.sessionToken(from: response), token)
        let bare = HTTPURLResponse(url: APIClient.baseURL, statusCode: 200, httpVersion: nil, headerFields: [:])!
        XCTAssertNil(APIClient.sessionToken(from: bare))
    }

    func testJobRequestEncodesTheClosedSets() throws {
        let staging = JobRequest(photoId: "pho_1", transformation: .staging, style: "Coastal", roomType: "Home Office")
        let s = try JSONSerialization.jsonObject(with: JSONEncoder().encode(staging)) as! [String: Any]
        XCTAssertEqual(s["transformation"] as? String, "staging")
        XCTAssertEqual(s["style"] as? String, "Coastal")
        XCTAssertEqual(s["roomType"] as? String, "Home Office")

        let twilight = JobRequest(photoId: "pho_1", transformation: .twilight)
        let t = try JSONSerialization.jsonObject(with: JSONEncoder().encode(twilight)) as! [String: Any]
        XCTAssertEqual(t["style"] as? String, "Dusk", "twilight is one look, sent silently")
        XCTAssertNil(t["roomType"])

        let declutter = JobRequest(photoId: "pho_1", transformation: .declutter, style: "Coastal")
        let d = try JSONSerialization.jsonObject(with: JSONEncoder().encode(declutter)) as! [String: Any]
        XCTAssertNil(d["style"], "declutter never sends a style")
        XCTAssertEqual(Catalog.stagingStyles, ["Standard", "Modern", "Contemporary", "Coastal", "Luxury"])
        XCTAssertEqual(Catalog.roomTypes.count, 8)
        XCTAssertEqual(usd(cents: 5699), "$56.99")
        XCTAssertEqual(creditsWord(1), "1 credit")
        XCTAssertEqual(creditsWord(2), "2 credits")
        XCTAssertEqual(resultFilename("staging", version: 2), "listing-lab-staging-version-2.jpg")
        XCTAssertEqual(resultFilename("twilight", version: 1, index: 3), "listing-lab-03-twilight.jpg")
    }
}
