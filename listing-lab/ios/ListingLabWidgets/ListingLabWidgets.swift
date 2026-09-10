import WidgetKit
import SwiftUI
import ActivityKit

/// The companion the phone runs outside the app: the Home Screen widget and
/// the lock-screen / Dynamic Island card for a job in progress.
@main
struct ListingLabWidgetsBundle: WidgetBundle {
    var body: some Widget {
        LatestPhotoWidget()
        JobActivityWidget()
    }
}

/// The app's colours, the few the widget needs (from assets/brand.md).
enum WTheme {
    static let bg = Color(red: 0x0C / 255, green: 0x11 / 255, blue: 0x18 / 255)
    static let surface = Color(red: 0x13 / 255, green: 0x1A / 255, blue: 0x24 / 255)
    static let text = Color(red: 0xE9 / 255, green: 0xED / 255, blue: 0xF3 / 255)
    static let textSoft = Color(red: 0xA0 / 255, green: 0xAB / 255, blue: 0xBA / 255)
    static let textFaint = Color(red: 0x6B / 255, green: 0x77 / 255, blue: 0x87 / 255)
    static let pine = Color(red: 0x4E / 255, green: 0x8F / 255, blue: 0xD0 / 255)
    static let ready = Color(red: 0x5E / 255, green: 0xCD / 255, blue: 0x96 / 255)
    static let returned = Color(red: 0xE0 / 255, green: 0x8A / 255, blue: 0x8A / 255)
}

// MARK: - The lock-screen card

struct JobActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: JobActivityAttributes.self) { context in
            LockScreenCard(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(WTheme.bg)
                .activitySystemActionForegroundColor(WTheme.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image("BrandMark").resizable().scaledToFit().frame(width: 36, height: 36).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StatusMark(state: context.state).padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(WTheme.text)
                        StatusLine(state: context.state)
                    }
                }
            } compactLeading: {
                Image("BrandMark").resizable().scaledToFit().frame(width: 22, height: 22)
            } compactTrailing: {
                StatusMark(state: context.state)
            } minimal: {
                StatusMark(state: context.state)
            }
            .keylineTint(WTheme.pine)
        }
    }
}

/// The card on the lock screen: the mark, the fix, and what is happening.
struct LockScreenCard: View {
    let attributes: JobActivityAttributes
    let state: JobActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 14) {
            Image("BrandMark").resizable().scaledToFit().frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 3) {
                Text("Listing Lab").font(.system(size: 11, weight: .semibold)).kerning(0.6).foregroundStyle(WTheme.textFaint)
                Text(attributes.label).font(.system(size: 17, weight: .semibold)).foregroundStyle(WTheme.text)
                StatusLine(state: state)
            }
            Spacer()
            StatusMark(state: state, large: true)
        }
        .padding(16)
    }
}

/// One line under the label: the running clock, or the outcome.
struct StatusLine: View {
    let state: JobActivityAttributes.ContentState
    var body: some View {
        switch state.status {
        case "delivered":
            Text("Ready — tap to see it").font(.system(size: 13)).foregroundStyle(WTheme.ready)
        case "returned":
            Text("Nothing delivered — credits returned").font(.system(size: 13)).foregroundStyle(WTheme.returned)
        default:
            HStack(spacing: 6) {
                Text(state.waitingOnUpstream ? "Waiting on the image service" : (state.take > 1 ? "Take \(state.take) — working on it" : "Working on it"))
                    .font(.system(size: 13)).foregroundStyle(WTheme.textSoft)
                Text(timerInterval: state.startedAt...state.startedAt.addingTimeInterval(4 * 3600), countsDown: false)
                    .font(.system(size: 13, design: .monospaced)).foregroundStyle(WTheme.textFaint)
                    .frame(maxWidth: 52, alignment: .leading)
            }
        }
    }
}

/// The small mark on the right: a spinner-ish ring while working, a tick when ready.
struct StatusMark: View {
    let state: JobActivityAttributes.ContentState
    var large = false
    var body: some View {
        let size: CGFloat = large ? 28 : 18
        switch state.status {
        case "delivered":
            Image(systemName: "checkmark.circle.fill").font(.system(size: size)).foregroundStyle(WTheme.ready)
        case "returned":
            Image(systemName: "arrow.uturn.backward.circle.fill").font(.system(size: size)).foregroundStyle(WTheme.returned)
        default:
            Image(systemName: "circle.dotted").font(.system(size: size, weight: .semibold)).foregroundStyle(WTheme.pine)
        }
    }
}

// MARK: - The Home Screen widget

struct LatestPhotoEntry: TimelineEntry {
    let date: Date
    let snapshot: SharedStore.Snapshot?
    let image: UIImage?
}

struct LatestPhotoProvider: TimelineProvider {
    func placeholder(in context: Context) -> LatestPhotoEntry { LatestPhotoEntry(date: .now, snapshot: nil, image: nil) }
    func getSnapshot(in context: Context, completion: @escaping (LatestPhotoEntry) -> Void) { completion(load()) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<LatestPhotoEntry>) -> Void) {
        // The app refreshes the widget itself whenever the list changes; this
        // is only the fallback cadence.
        completion(Timeline(entries: [load()], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
    private func load() -> LatestPhotoEntry {
        let snapshot = SharedStore.read()
        let image = SharedStore.latestImageURL.flatMap { UIImage(contentsOfFile: $0.path) }
        return LatestPhotoEntry(date: .now, snapshot: snapshot, image: image)
    }
}

struct LatestPhotoWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.horizonhomemedia.listinglab.latest", provider: LatestPhotoProvider()) { entry in
            LatestPhotoView(entry: entry)
                .containerBackground(WTheme.bg, for: .widget)
        }
        .configurationDisplayName("Latest photo")
        .description("Your most recent finished photo, and what is still working.")
        .supportedFamilies([.systemSmall, .systemMedium])
        .contentMarginsDisabled()
    }
}

struct LatestPhotoView: View {
    @Environment(\.widgetFamily) private var family
    let entry: LatestPhotoEntry

    var body: some View {
        if let image = entry.image {
            ZStack(alignment: .bottomLeading) {
                Image(uiImage: image).resizable().scaledToFill()
                LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .center, endPoint: .bottom)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.snapshot?.latestLabel ?? "Ready").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    if let working = entry.snapshot?.working, working > 0 {
                        Text(working == 1 ? "1 photo working" : "\(working) photos working").font(.system(size: 11)).foregroundStyle(WTheme.pine)
                    } else if let at = entry.snapshot?.latestAt {
                        Text(at, style: .relative).font(.system(size: 11)).foregroundStyle(.white.opacity(0.75))
                    }
                }
                .padding(12)
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Image("BrandMark").resizable().scaledToFit().frame(width: 40, height: 40)
                Spacer(minLength: 0)
                if let working = entry.snapshot?.working, working > 0 {
                    Text(working == 1 ? "1 photo working" : "\(working) photos working").font(.system(size: 13, weight: .semibold)).foregroundStyle(WTheme.text)
                    Text("Listing Lab").font(.system(size: 11)).foregroundStyle(WTheme.textFaint)
                } else {
                    Text("Listing Lab").font(.system(size: 13, weight: .semibold)).foregroundStyle(WTheme.text)
                    Text("Nothing yet. Upload a photo to get started.").font(.system(size: 11)).foregroundStyle(WTheme.textFaint)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(14)
        }
    }
}
