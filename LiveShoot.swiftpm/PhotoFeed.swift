import Photos
import SwiftUI

/// 사진 보관함을 지켜보다가 새로 들어온 사진을 assets 맨 앞에 넣는다.
/// 카메라 시계가 틀려도 되도록 촬영 시각이 아니라 "보관함에 들어온 순서"를 쓴다.
final class PhotoFeed: NSObject, ObservableObject, PHPhotoLibraryChangeObserver {
    @Published var status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published var assets: [PHAsset] = []      // 이번 촬영에 들어온 사진, 최신이 앞
    @Published var liked: Set<String> = []     // 하트 (사진 보관함 즐겨찾기와 같음)
    @Published var running = false
    private var all: PHFetchResult<PHAsset>?

    func requestAccess() {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { s in
            DispatchQueue.main.async { self.status = s }
        }
    }

    /// recent: 시작할 때 이미 보관함에 있던 최근 사진 몇 장을 같이 보여 준다 (0이면 새 사진만)
    func start(recent: Int) {
        let opts = PHFetchOptions()
        opts.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        let result = PHAsset.fetchAssets(with: opts)
        all = result
        var start: [PHAsset] = []
        let n = result.count
        for i in stride(from: n - 1, through: max(0, n - recent), by: -1) where recent > 0 {
            start.append(result.object(at: i))
        }
        assets = start
        liked = Set(start.filter(\.isFavorite).map(\.localIdentifier))
        PHPhotoLibrary.shared().register(self)
        running = true
    }

    func stop() {
        PHPhotoLibrary.shared().unregisterChangeObserver(self)
        running = false
    }

    func photoLibraryDidChange(_ change: PHChange) {
        DispatchQueue.main.async {
            guard let all = self.all, let d = change.changeDetails(for: all) else { return }
            self.all = d.fetchResultAfterChanges
            let known = Set(self.assets.map(\.localIdentifier))
            for a in d.insertedObjects where !known.contains(a.localIdentifier) {
                self.assets.insert(a, at: 0)
                if a.isFavorite { self.liked.insert(a.localIdentifier) }
            }
        }
    }

    func toggleLike(_ a: PHAsset) {
        let on = !liked.contains(a.localIdentifier)
        if on { liked.insert(a.localIdentifier) } else { liked.remove(a.localIdentifier) }
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest(for: a).isFavorite = on
        })
    }
}
