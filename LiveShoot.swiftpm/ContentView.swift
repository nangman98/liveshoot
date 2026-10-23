import Photos
import SwiftUI
#if os(iOS)
import UIKit
#endif

@main
struct LiveShootApp: App {
    @StateObject private var feed = PhotoFeed()
    var body: some Scene {
        WindowGroup { ContentView().environmentObject(feed) }
    }
}

struct ContentView: View {
    @EnvironmentObject var feed: PhotoFeed
    @State private var selected: String?
    @State private var follow = true        // 새 사진이 오면 자동으로 그 사진으로
    @State private var look = Look.original
    @State private var clientMode = false   // 고객 보기: 사진만
    @State private var recent = 0

    var body: some View {
        Group {
            if feed.status != .authorized && feed.status != .limited {
                VStack(spacing: 16) {
                    Text("사진 보관함 접근이 필요합니다").font(.title2)
                    Text("Creators' App(소니)이나 GR WORLD(리코)가 iPad 사진 보관함에 넣은 사진을 바로 보여 줍니다.")
                        .multilineTextAlignment(.center).foregroundColor(.secondary)
                    Button("허용하기") { feed.requestAccess() }.buttonStyle(.borderedProminent)
                }.padding()
            } else if !feed.running {
                VStack(spacing: 20) {
                    Text("LiveShoot").font(.largeTitle.bold())
                    Text("시작을 누른 뒤 카메라 앱에서 iPad로 사진을 보내면 여기에 바로 뜹니다.")
                        .multilineTextAlignment(.center).foregroundColor(.secondary)
                    Stepper("시작할 때 최근 사진 \(recent)장도 보기", value: $recent, in: 0...200, step: 10)
                        .frame(maxWidth: 360)
                    Button("촬영 시작") { feed.start(recent: recent); selected = feed.assets.first?.localIdentifier }
                        .buttonStyle(.borderedProminent).controlSize(.large)
                }.padding()
            } else if clientMode {
                clientView
            } else {
                shootView
            }
        }
        .onChange(of: feed.assets.first?.localIdentifier) { newest in
            if follow || selected == nil { selected = newest }
        }
        .onChange(of: feed.running) { on in
            #if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = on   // 촬영 중 화면 꺼짐 방지
            #endif
        }
    }

    private var current: PHAsset? {
        feed.assets.first { $0.localIdentifier == selected } ?? feed.assets.first
    }

    private var shootView: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text("\(feed.assets.count)장").font(.headline).monospacedDigit()
                Picker("느낌", selection: $look) {
                    ForEach(Look.allCases) { Text($0.rawValue).tag($0) }
                }.pickerStyle(.segmented).frame(maxWidth: 380)
                Toggle("새 사진 따라가기", isOn: $follow).fixedSize()
                Spacer()
                Button { clientMode = true } label: { Label("고객 보기", systemImage: "rectangle.on.rectangle") }
                Button(role: .destructive) { feed.stop() } label: { Label("끝", systemImage: "stop.circle") }
            }
            .padding(.horizontal).padding(.vertical, 8)

            ZStack(alignment: .bottomTrailing) {
                Color.black
                if let a = current {
                    LargePhoto(asset: a, look: look)
                        .onTapGesture(count: 2) { feed.toggleLike(a) }
                    Button { feed.toggleLike(a) } label: {
                        Image(systemName: feed.liked.contains(a.localIdentifier) ? "heart.fill" : "heart")
                            .font(.system(size: 34)).foregroundColor(.red).padding(20)
                    }
                } else {
                    Text("사진을 기다리는 중…").foregroundColor(.gray)
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(feed.assets, id: \.localIdentifier) { a in
                        Thumb(asset: a, selected: a.localIdentifier == current?.localIdentifier,
                              liked: feed.liked.contains(a.localIdentifier))
                            .onTapGesture { selected = a.localIdentifier; follow = (a.localIdentifier == feed.assets.first?.localIdentifier) }
                    }
                }.padding(8)
            }
            .frame(height: 100)
            .background(Color.black)
        }
    }

    /// 고객 보기: 사진만 크게, 좌우로 넘김. 길게 누르면 돌아온다.
    private var clientView: some View {
        TabView(selection: Binding(get: { current?.localIdentifier ?? "" }, set: { selected = $0 })) {
            ForEach(feed.assets, id: \.localIdentifier) { a in
                LargePhoto(asset: a, look: look)
                    .tag(a.localIdentifier)
                    .onTapGesture(count: 2) { feed.toggleLike(a) }
            }
        }
        #if os(iOS)
        .tabViewStyle(.page(indexDisplayMode: .never))
        .statusBarHidden(true)
        #endif
        .background(Color.black)
        .ignoresSafeArea()
        .onLongPressGesture(minimumDuration: 1.2) { clientMode = false }
    }
}
