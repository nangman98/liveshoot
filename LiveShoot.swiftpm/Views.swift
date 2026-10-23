import PhotosUI
import SwiftUI
#if os(iOS)
import UIKit
#endif

@main
struct LiveShootApp: App {
    @StateObject private var session = Session()
    var body: some Scene {
        WindowGroup { RootView().environmentObject(session) }
    }
}

struct RootView: View {
    @EnvironmentObject var s: Session
    @State private var clientMode = false

    var body: some View {
        Group {
            if clientMode { ClientView(exit: { clientMode = false }) } else { EditorView(clientMode: $clientMode) }
        }
        .onChange(of: s.ftpOn || s.grOn || s.photosOn) { on in
            #if os(iOS)
            UIApplication.shared.isIdleTimerDisabled = on   // 받는 중에는 화면 꺼짐 방지
            #endif
        }
    }
}

struct RenderKey: Hashable { let id: String; let edit: Edit; let original: Bool }

/// 한 장을 보정해서 그린다. 슬라이더가 움직이면 다시 그린다.
struct RenderedPhoto: View {
    @EnvironmentObject var s: Session
    let shot: Shot
    var original = false
    @State private var image: CGImage?

    var body: some View {
        ZStack {
            Color.black
            if let image {
                Image(decorative: image, scale: 1).resizable().scaledToFit()
            } else {
                ProgressView()
            }
        }
        .task(id: RenderKey(id: shot.id, edit: shot.edit, original: original)) {
            if let cg = await s.render(shot, original: original), !Task.isCancelled { image = cg }
        }
    }
}

struct EditorView: View {
    @EnvironmentObject var s: Session
    @Binding var clientMode: Bool
    @State private var showOriginal = false

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                topBar
                canvas
                filmstrip
            }
            Divider()
            SidePanel().frame(width: 340)
        }
    }

    private var topBar: some View {
        HStack(spacing: 14) {
            Text("LiveShoot").font(.headline)
            Text("\(s.shots.count)장 · 하트 \(s.shots.filter(\.liked).count)").foregroundColor(.secondary).monospacedDigit()
            Toggle("새 사진 따라가기", isOn: $s.follow).fixedSize()
            Spacer()
            Button { clientMode = true } label: { Label("고객 보기", systemImage: "rectangle.on.rectangle") }
                .disabled(s.shots.isEmpty)
        }
        .padding(.horizontal).padding(.vertical, 8)
    }

    private var canvas: some View {
        ZStack(alignment: .bottom) {
            if let shot = s.current {
                RenderedPhoto(shot: shot, original: showOriginal)
                    .onTapGesture(count: 2) { s.toggleLike(shot.id) }
                HStack {
                    Text("\(shot.name) · \(shot.source.rawValue)").font(.caption).foregroundColor(.white.opacity(0.8))
                    Spacer()
                    Text(showOriginal ? "원본" : "누르고 있으면 원본")
                        .font(.callout).padding(.horizontal, 12).padding(.vertical, 6)
                        .background(Capsule().fill(Color.white.opacity(showOriginal ? 0.9 : 0.25)))
                        .foregroundColor(showOriginal ? .black : .white)
                        .gesture(DragGesture(minimumDistance: 0)
                            .onChanged { _ in showOriginal = true }
                            .onEnded { _ in showOriginal = false })
                    Button { s.toggleLike(shot.id) } label: {
                        Image(systemName: shot.liked ? "heart.fill" : "heart").font(.system(size: 30)).foregroundColor(.red)
                    }
                }
                .padding(14)
            } else {
                Color.black
                Text("오른쪽 '받기'를 켜고 촬영하거나, 이미 있는 사진을 가져오면 여기에 뜹니다").foregroundColor(.gray).padding(.bottom, 200)
            }
        }
    }

    private var filmstrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(spacing: 6) {
                ForEach(s.shots) { shot in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if let t = s.thumbs[shot.id] {
                                Image(decorative: t, scale: 1).resizable().scaledToFill()
                            } else {
                                Color.gray.opacity(0.3)
                            }
                        }
                        .frame(width: 84, height: 84).clipped()
                        .overlay(Rectangle().stroke(shot.id == s.current?.id ? Color.orange : .clear, lineWidth: 3))
                        HStack(spacing: 2) {
                            if shot.exported { Image(systemName: "checkmark.circle.fill").foregroundColor(.green) }
                            if shot.liked { Image(systemName: "heart.fill").foregroundColor(.red) }
                        }.padding(3)
                    }
                    .onTapGesture {
                        s.selectedID = shot.id
                        s.follow = shot.id == s.shots.first?.id
                    }
                }
            }.padding(8)
        }
        .frame(height: 100)
        .background(Color.black)
    }
}

struct SidePanel: View {
    @EnvironmentObject var s: Session
    @State private var confirmClear = false
    @State private var picked: [PhotosPickerItem] = []
    @State private var showImporter = false

    private var edit: Binding<Edit> {
        Binding(get: { s.current?.edit ?? Edit() }, set: { s.updateEdit($0) })
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                GroupBox("받기") {
                    VStack(alignment: .leading, spacing: 8) {
                        Toggle("a7 IV (FTP)", isOn: Binding(get: { s.ftpOn }, set: { s.setFTP($0) }))
                        if s.ftpOn {
                            Text("카메라 FTP 서버: \(s.ftpAddress)\n사용자 liveshoot · 비밀번호 liveshoot · 수동(PASV) · 보안 끔")
                                .font(.caption).foregroundColor(.secondary)
                            Text(s.ftpState).font(.caption)
                        }
                        Toggle("GR III (Wi-Fi)", isOn: Binding(get: { s.grOn }, set: { s.setGR($0) }))
                        if s.grOn { Text(s.grState).font(.caption).foregroundColor(.secondary) }
                        Toggle("사진 보관함 (새 사진)", isOn: Binding(get: { s.photosOn }, set: { s.setPhotos($0) }))
                        if s.photosOn { Text(s.photosState).font(.caption).foregroundColor(.secondary) }
                        Divider()
                        Text("이미 있는 사진 가져오기").font(.caption).foregroundColor(.secondary)
                        HStack {
                            PhotosPicker(selection: $picked, matching: .images) {
                                Label("보관함에서", systemImage: "photo.on.rectangle")
                            }
                            Spacer()
                            Button { showImporter = true } label: { Label("파일에서", systemImage: "folder") }
                        }
                        .onChange(of: picked) { items in
                            if !items.isEmpty { s.importPicked(items); picked = [] }
                        }
                        .fileImporter(isPresented: $showImporter, allowedContentTypes: [.image], allowsMultipleSelection: true) { r in
                            if case let .success(urls) = r { s.importFiles(urls) }
                        }
                    }
                }

                GroupBox("보정") {
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle(isOn: edit.autoExposure) {
                            Text("자동 노출" + (s.current.map { String(format: "  %+.2f EV", $0.autoEV) } ?? ""))
                        }
                        EditSlider(label: "노출", value: edit.exposure, range: -3...3, format: "%+.2f EV")
                        EditSlider(label: "대비", value: edit.contrast, range: -100...100)
                        EditSlider(label: "하이라이트", value: edit.highlights, range: -100...100)
                        EditSlider(label: "섀도", value: edit.shadows, range: -100...100)
                        EditSlider(label: "색온도", value: edit.temperature, range: -100...100)
                        EditSlider(label: "색조", value: edit.tint, range: -100...100)
                        EditSlider(label: "Vibrance", value: edit.vibrance, range: -100...100)
                        EditSlider(label: "채도", value: edit.saturation, range: -100...100)
                        HStack {
                            Button("초기화") { edit.wrappedValue = Edit() }
                            Spacer()
                            Button("기본 보정 입히기") { edit.wrappedValue = s.defaultEdit }
                            Button("기본으로 저장") { s.defaultEdit = edit.wrappedValue; s.message = "새 사진의 기본 보정으로 저장함" }
                        }.font(.callout)
                        Toggle("새 사진에 이 보정 이어 쓰기", isOn: $s.carryOver).font(.callout)
                    }
                    .disabled(s.current == nil)
                }

                GroupBox("내보내기") {
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("크기", selection: $s.exportEdge) {
                            Text("2400 (홈페이지)").tag(2400)
                            Text("3000").tag(3000)
                            Text("4000").tag(4000)
                            Text("원본").tag(0)
                        }.pickerStyle(.segmented)
                        Stepper("품질 \(s.exportQuality)", value: $s.exportQuality, in: 60...100, step: 5)
                        HStack {
                            Button("이 사진") { if let c = s.current { s.export([c.id]) } }.disabled(s.current == nil)
                            Spacer()
                            let liked = s.shots.filter(\.liked).map(\.id)
                            Button("하트 \(liked.count)장 전부") { s.export(liked) }.disabled(liked.isEmpty)
                        }
                        Text("사진 보관함 'LiveShoot' 앨범에 저장 (원본은 그대로)").font(.caption).foregroundColor(.secondary)
                    }
                }

                if let m = s.message { Text(m).font(.callout).foregroundColor(.orange) }

                Button("받은 사진 목록 비우기", role: .destructive) { confirmClear = true }
                    .font(.callout)
                    .confirmationDialog("앱에 받은 원본과 보정값을 지웁니다. 사진 보관함과 내보낸 파일은 남습니다.", isPresented: $confirmClear) {
                        Button("지우기", role: .destructive) { s.clearIncoming() }
                    }
            }
            .padding()
        }
    }
}

struct EditSlider: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    var format = "%+.0f"

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(label).font(.callout)
                Spacer()
                Text(String(format: format, value)).font(.callout).monospacedDigit().foregroundColor(.secondary)
            }
            Slider(value: $value, in: range)
                .onTapGesture(count: 2) { value = 0 }   // 두 번 누르면 0
        }
    }
}

/// 고객 보기: 버튼 없이 사진만, 좌우로 넘김. 1.2초 길게 누르면 돌아온다.
struct ClientView: View {
    @EnvironmentObject var s: Session
    let exit: () -> Void

    var body: some View {
        TabView(selection: Binding(get: { s.current?.id ?? "" }, set: { s.selectedID = $0 })) {
            ForEach(s.shots) { shot in
                RenderedPhoto(shot: shot)
                    .tag(shot.id)
                    .onTapGesture(count: 2) { s.toggleLike(shot.id) }
            }
        }
        #if os(iOS)
        .tabViewStyle(.page(indexDisplayMode: .never))
        .statusBarHidden(true)
        #endif
        .background(Color.black)
        .ignoresSafeArea()
        .onLongPressGesture(minimumDuration: 1.2) { exit() }
    }
}
