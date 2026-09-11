import XCTest
@testable import ListingLab

/// The library kept on the phone (11 Sep 2026). The promise is that My photos
/// opens full with no network at all, which comes down to three things: the
/// list survives a relaunch, a picture once fetched is read off the phone
/// rather than the wire, and signing out takes both away.
final class LocalLibraryTests: XCTestCase {
    override func setUp() { super.setUp(); LocalLibrary.clear() }
    override func tearDown() { LocalLibrary.clear(); super.tearDown() }

    private func job(_ id: String, status: String = "delivered") -> JobSummary {
        let json = """
        { "jobId": "\(id)", "photoId": "pho_\(id)", "transformation": "twilight", "style": "Dusk",
          "roomType": null, "status": "\(status)", "waitingOnUpstream": false,
          "originalUrl": "/api/photos/acct%2F\(id)%2Foriginal",
          "resultUrl": "/api/photos/acct%2F\(id)%2Fresult.jpg",
          "variantUrls": [], "rejectUrl": null,
          "previewUrl": "/api/photos/acct%2F\(id)%2Fresult.jpg?preview=1",
          "note": null, "startedAt": "2026-09-11T10:00:00.000Z", "finishedAt": "2026-09-11T10:03:00.000Z" }
        """
        return try! JSONDecoder().decode(JobSummary.self, from: Data(json.utf8))
    }

    func testTheListSurvivesBeingWrittenAndReadBack() {
        XCTAssertNil(LocalLibrary.loadJobs(), "nothing kept before anything is saved")
        let jobs = [job("a"), job("b", status: "rejected"), job("c", status: "running")]
        LocalLibrary.saveJobs(jobs)

        let back = LocalLibrary.loadJobs()
        XCTAssertEqual(back, jobs, "every field, exactly as it went in")
        XCTAssertEqual(back?.first?.thumbnailUrl, "/api/photos/acct%2Fa%2Fresult.jpg?preview=1")
        XCTAssertEqual(back?[1].jobStatus, .rejected)
        XCTAssertEqual(back?[2].jobStatus, .running)
    }

    func testTheNewestListReplacesTheOneBeforeIt() {
        LocalLibrary.saveJobs([job("old1"), job("old2")])
        LocalLibrary.saveJobs([job("new1")])
        XCTAssertEqual(LocalLibrary.loadJobs()?.map(\.jobId), ["new1"], "not appended to")
    }

    func testAPictureIsReadOffThePhoneAfterItHasBeenFetchedOnce() {
        let path = "/api/photos/acct%2Fa%2Fresult.jpg?preview=1"
        XCTAssertFalse(LocalLibrary.hasImage(for: path))
        XCTAssertNil(LocalLibrary.imageData(for: path))

        let bytes = Data("pretend JPEG bytes".utf8)
        LocalLibrary.saveImage(bytes, for: path)
        XCTAssertTrue(LocalLibrary.hasImage(for: path))
        XCTAssertEqual(LocalLibrary.imageData(for: path), bytes)

        // A different photo is a different file, however similar the address.
        XCTAssertNil(LocalLibrary.imageData(for: path + "&x=1"))
    }

    func testAnAddressThatIsNotALegalFilenameIsStillFine() {
        // Server paths carry slashes, percent escapes and a query.
        let awkward = "/api/photos/acct_1%2Fpho_2%2Fjob_3-result.jpg?preview=1&download=0"
        LocalLibrary.saveImage(Data([0xFF, 0xD8, 0xFF]), for: awkward)
        XCTAssertEqual(LocalLibrary.imageData(for: awkward), Data([0xFF, 0xD8, 0xFF]))
    }

    func testPruningLeavesASmallLibraryAlone() {
        let path = "/api/photos/keep-me"
        LocalLibrary.saveImage(Data(count: 1024), for: path)
        LocalLibrary.pruneImages()
        XCTAssertTrue(LocalLibrary.hasImage(for: path), "well under the cap, so nothing is thrown away")
    }

    func testSigningOutTakesTheWholeLibraryWithIt() {
        LocalLibrary.saveJobs([job("a")])
        LocalLibrary.saveImage(Data("bytes".utf8), for: "/api/photos/acct%2Fa%2Fresult.jpg")
        LocalLibrary.clear()
        XCTAssertNil(LocalLibrary.loadJobs())
        XCTAssertFalse(LocalLibrary.hasImage(for: "/api/photos/acct%2Fa%2Fresult.jpg"))
        // And the folder comes back for the next person, rather than staying broken.
        LocalLibrary.saveImage(Data("after".utf8), for: "/api/photos/fresh")
        XCTAssertEqual(LocalLibrary.imageData(for: "/api/photos/fresh"), Data("after".utf8))
    }
}
