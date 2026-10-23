import CoreImage
import Photos
import SwiftUI

enum Source: String, Codable {
    case ftp = "a7 IV"
    case gr = "GR III"
    case photos = "보관함"
}

struct Shot: Identifiable, Equatable {
    let id: String          // 파일 경로 또는 PHAsset localIdentifier
    let name: String
    let source: Source
    let url: URL?
    let assetID: String?
    var edit: Edit
    var autoEV: Double
    var liked = false
    var exported = false
}

/// 들어온 사진 목록, 받기(FTP·GR·보관함), 미리보기 캐시, 내보내기를 맡는다.
final class Session: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published var shots: [Shot] = [] { didSet { scheduleSave() } }   // 최신이 앞
    @Published var selectedID: String?
    @Published var follow = true          // 새 사진이 오면 그 사진으로
    @Published var carryOver = false      // 새 사진에 지금 사진의 보정을 이어 씀
    @Published var exportEdge = 2400      // 긴 변 px, 0이면 원본 크기 (홈페이지 기준 2400)
    @Published var exportQuality = 85     // JPEG 품질 (홈페이지 기준 85)
    @Published var ftpOn = false
    @Published var grOn = false
    @Published var photosOn = false
    @Published var ftpState = "꺼짐"
    @Published var grState = "꺼짐"
    @Published var photosState = "꺼짐"
    @Published var message: String?
    @Published var thumbs: [String: CGImage] = [:]

    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    private var incoming: URL { docs.appendingPathComponent("Incoming") }
    private var exportDir: URL { docs.appendingPathComponent("Export") }
    private var stateURL: URL { docs.appendingPathComponent("liveshoot_state.json") }
    private lazy var ftp = FTPServer(folder: incoming.appendingPathComponent("a7IV"))
    private lazy var gr = GRClient(folder: incoming.appendingPathComponent("GR"))
    private var allAssets: PHFetchResult<PHAsset>?
    private var previews: [String: CIImage] = [:]
    private var previewOrder: [String] = []
    private let work = DispatchQueue(label: "liveshoot.work", qos: .userInitiated)
    private var saveItem: DispatchWorkItem?

    var current: Shot? { shots.first { $0.id == selectedID } ?? shots.first }
    var ftpAddress: String { "\(wifiIPv4() ?? "Wi-Fi 없음") : \(ftp.port)" }

    var defaultEdit: Edit {
        get {
            guard let d = UserDefaults.standard.data(forKey: "defaultEdit"),
                  let e = try? JSONDecoder().decode(Edit.self, from: d) else { return Edit() }
            return e
        }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: "defaultEdit") }
    }

    override init() {
        super.init()
        ftp.onFile = { [weak self] url in self?.add(url: url, source: .ftp) }
        ftp.onState = { [weak self] s in DispatchQueue.main.async { self?.ftpState = s } }
        gr.onFile = { [weak self] url in self?.add(url: url, source: .gr) }
        gr.onState = { [weak self] s in DispatchQueue.main.async { self?.grState = s } }
        restore()
    }

    // MARK: 받기

    func setFTP(_ on: Bool) {
        ftpOn = on
        if on {
            do { try ftp.start() } catch { ftpState = "오류: \(error)"; ftpOn = false }
        } else {
            ftp.stop()
        }
    }

    func setGR(_ on: Bool) {
        grOn = on
        if on { gr.start() } else { gr.stop() }
    }

    func setPhotos(_ on: Bool) {
        photosOn = on
        guard on else {
            PHPhotoLibrary.shared().unregisterChangeObserver(self)
            photosState = "꺼짐"
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { st in
            DispatchQueue.main.async {
                guard st == .authorized || st == .limited else {
                    self.photosState = "사진 접근이 허용되지 않음 (설정 앱에서 허용)"
                    self.photosOn = false
                    return
                }
                let o = PHFetchOptions()
                o.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
                self.allAssets = PHAsset.fetchAssets(with: o)
                PHPhotoLibrary.shared().register(self)
                self.photosState = "새 사진 대기 중"
            }
        }
    }

    func photoLibraryDidChange(_ change: PHChange) {
        DispatchQueue.main.async {
            guard let all = self.allAssets, let d = change.changeDetails(for: all) else { return }
            self.allAssets = d.fetchResultAfterChanges
            for a in d.insertedObjects where !self.shots.contains(where: { $0.id == a.localIdentifier }) {
                self.addAsset(a)
            }
        }
    }

    private func addAsset(_ a: PHAsset) {
        let name = PHAssetResource.assetResources(for: a).first?.originalFilename ?? "photo.jpg"
        assetData(a.localIdentifier) { data in
            guard let data, let pv = Renderer.load(data: data, maxPixel: 2560) else { return }
            self.insert(id: a.localIdentifier, name: name, source: .photos, url: nil, assetID: a.localIdentifier, preview: pv)
        }
    }

    /// 받은 파일을 목록 맨 앞에 넣는다 (어느 스레드에서 불러도 됨)
    func add(url: URL, source: Source) {
        let ext = url.pathExtension.lowercased()
        guard ["jpg", "jpeg", "heic", "heif", "png"].contains(ext) else { return }   // RAW는 받기만 하고 띄우지 않음
        work.async {
            guard let pv = Renderer.load(url: url, maxPixel: 2560) else { return }
            self.insert(id: url.path, name: url.lastPathComponent, source: source, url: url, assetID: nil, preview: pv)
        }
    }

    private func insert(id: String, name: String, source: Source, url: URL?, assetID: String?, preview: CIImage) {
        let ev = Renderer.autoEV(preview)
        let thumb = Renderer.thumbnail(preview, side: 200)
        DispatchQueue.main.async {
            guard !self.shots.contains(where: { $0.id == id }) else { return }
            self.cache(id, preview)
            let edit = self.carryOver ? (self.current?.edit ?? self.defaultEdit) : self.defaultEdit
            self.shots.insert(Shot(id: id, name: name, source: source, url: url, assetID: assetID, edit: edit, autoEV: ev), at: 0)
            self.thumbs[id] = thumb
            if self.follow || self.selectedID == nil { self.selectedID = id }
        }
    }

    // MARK: 미리보기·렌더

    private func cache(_ id: String, _ im: CIImage) {
        previews[id] = im
        previewOrder.removeAll { $0 == id }
        previewOrder.append(id)
        while previewOrder.count > 8 { previews.removeValue(forKey: previewOrder.removeFirst()) }
    }

    private func assetData(_ id: String, done: @escaping (Data?) -> Void) {
        guard let a = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else { done(nil); return }
        let o = PHImageRequestOptions()
        o.isNetworkAccessAllowed = true
        o.deliveryMode = .highQualityFormat
        o.isSynchronous = false
        PHImageManager.default().requestImageDataAndOrientation(for: a, options: o) { d, _, _, _ in
            self.work.async { done(d) }
        }
    }

    /// 화면용 미리보기(긴 변 2560)에 보정을 입힌 그림. original이면 보정 없이.
    func render(_ shot: Shot, original: Bool) async -> CGImage? {
        let pv: CIImage? = await withCheckedContinuation { cont in
            DispatchQueue.main.async {
                if let p = self.previews[shot.id] { self.cache(shot.id, p); cont.resume(returning: p); return }
                let finish: (CIImage?) -> Void = { p in
                    DispatchQueue.main.async { if let p { self.cache(shot.id, p) }; cont.resume(returning: p) }
                }
                if let url = shot.url {
                    self.work.async { finish(Renderer.load(url: url, maxPixel: 2560)) }
                } else if let id = shot.assetID {
                    self.assetData(id) { d in finish(d.flatMap { Renderer.load(data: $0, maxPixel: 2560) }) }
                } else {
                    finish(nil)
                }
            }
        }
        guard let pv else { return nil }
        let im = original ? pv : Renderer.apply(shot.edit, autoEV: shot.autoEV, to: pv)
        return await withCheckedContinuation { cont in
            work.async { cont.resume(returning: Renderer.cgImage(im)) }
        }
    }

    // MARK: 보정

    func updateEdit(_ e: Edit) {
        guard let i = shots.firstIndex(where: { $0.id == current?.id }) else { return }
        shots[i].edit = e
        shots[i].exported = false
    }

    func toggleLike(_ id: String) {
        guard let i = shots.firstIndex(where: { $0.id == id }) else { return }
        shots[i].liked.toggle()
        let on = shots[i].liked
        if let aid = shots[i].assetID, let a = PHAsset.fetchAssets(withLocalIdentifiers: [aid], options: nil).firstObject {
            PHPhotoLibrary.shared().performChanges({ PHAssetChangeRequest(for: a).isFavorite = on })
        }
    }

    // MARK: 내보내기

    /// 원본에서 다시 읽어 보정을 입히고, 긴 변 exportEdge·품질 exportQuality JPEG로 사진 보관함 "LiveShoot" 앨범에 저장 (앱 Export 폴더에도 사본)
    func export(_ ids: [String]) {
        let list = shots.filter { ids.contains($0.id) }
        guard !list.isEmpty else { return }
        let edge = exportEdge, q = Double(exportQuality) / 100
        message = "내보내는 중 \(list.count)장"
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in
            self.exportNext(list[...], edge: edge, quality: q, done: 0)
        }
    }

    private func exportNext(_ rest: ArraySlice<Shot>, edge: Int, quality: Double, done: Int) {
        guard let s = rest.first else {
            DispatchQueue.main.async { self.message = "내보내기 끝: \(done)장 (긴 변 \(edge == 0 ? "원본" : "\(edge) px"), 품질 \(Int(quality * 100)))" }
            return
        }
        let next: (Data?) -> Void = { src in
            var ok = false
            let full: CIImage? = s.url.flatMap { Renderer.load(url: $0, maxPixel: edge) } ?? src.flatMap { Renderer.load(data: $0, maxPixel: edge) }
            if let full, let jpg = Renderer.jpeg(Renderer.apply(s.edit, autoEV: s.autoEV, to: full), quality: quality) {
                try? FileManager.default.createDirectory(at: self.exportDir, withIntermediateDirectories: true)
                let stem = (s.name as NSString).deletingPathExtension
                try? jpg.write(to: uniqueURL(self.exportDir, stem + "_edit.jpg"))
                self.saveToAlbum(jpg)
                ok = true
                DispatchQueue.main.async {
                    if let i = self.shots.firstIndex(where: { $0.id == s.id }) { self.shots[i].exported = true }
                }
            }
            self.exportNext(rest.dropFirst(), edge: edge, quality: quality, done: done + (ok ? 1 : 0))
        }
        if s.url != nil { work.async { next(nil) } } else if let id = s.assetID { assetData(id, done: next) } else { work.async { next(nil) } }
    }

    private func saveToAlbum(_ jpg: Data) {
        let lib = PHPhotoLibrary.shared()
        let find = PHFetchOptions()
        find.predicate = NSPredicate(format: "title == %@", "LiveShoot")
        let album = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: find).firstObject
        try? lib.performChangesAndWait {
            let req = PHAssetCreationRequest.forAsset()
            req.addResource(with: .photo, data: jpg, options: nil)
            guard let ph = req.placeholderForCreatedAsset else { return }
            if let album {
                PHAssetCollectionChangeRequest(for: album)?.addAssets([ph] as NSArray)
            } else {
                PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: "LiveShoot").addAssets([ph] as NSArray)
            }
        }
    }

    // MARK: 저장·복원 (받은 파일과 보정값은 앱을 껐다 켜도 남는다)

    private struct Saved: Codable { var edit: Edit; var autoEV: Double; var liked: Bool; var exported: Bool }

    private func scheduleSave() {
        saveItem?.cancel()
        let snapshot = shots
        let item = DispatchWorkItem { [stateURL] in
            var d: [String: Saved] = [:]
            for s in snapshot where s.url != nil {
                d[s.url!.lastPathComponent] = Saved(edit: s.edit, autoEV: s.autoEV, liked: s.liked, exported: s.exported)
            }
            try? JSONEncoder().encode(d).write(to: stateURL)
        }
        saveItem = item
        work.asyncAfter(deadline: .now() + 1, execute: item)
    }

    private func restore() {
        let saved = (try? Data(contentsOf: stateURL)).flatMap { try? JSONDecoder().decode([String: Saved].self, from: $0) } ?? [:]
        var found: [(URL, Source, Date)] = []
        for (sub, src) in [("a7IV", Source.ftp), ("GR", Source.gr)] {
            let dir = incoming.appendingPathComponent(sub)
            let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.creationDateKey])) ?? []
            for f in files where !f.lastPathComponent.hasPrefix(".") {
                let date = (try? f.resourceValues(forKeys: [.creationDateKey]).creationDate) ?? .distantPast
                found.append((f, src, date))
            }
        }
        shots = found.sorted { $0.2 > $1.2 }.compactMap { f in
            guard let s = saved[f.0.lastPathComponent] else { return nil }   // 저장된 보정이 있는 것만 되살림
            return Shot(id: f.0.path, name: f.0.lastPathComponent, source: f.1, url: f.0, assetID: nil,
                        edit: s.edit, autoEV: s.autoEV, liked: s.liked, exported: s.exported)
        }
        for s in shots {
            let url = s.url!
            work.async {
                let t = Renderer.load(url: url, maxPixel: 200).flatMap { Renderer.cgImage($0) }
                DispatchQueue.main.async { self.thumbs[s.id] = t }
            }
        }
    }

    /// 목록과 받은 파일을 지운다 (사진 보관함과 내보낸 파일은 그대로)
    func clearIncoming() {
        try? FileManager.default.removeItem(at: incoming)
        try? FileManager.default.removeItem(at: stateURL)
        shots = []
        thumbs = [:]
        previews = [:]
        previewOrder = []
        selectedID = nil
    }
}
