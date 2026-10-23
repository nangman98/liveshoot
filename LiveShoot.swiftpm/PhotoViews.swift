import CoreImage
import Photos
import SwiftUI

/// 화면에서만 바꾸는 빠른 느낌. 원본 파일은 건드리지 않는다.
enum Look: String, CaseIterable, Identifiable {
    case original = "원본", bright = "밝게", warm = "따뜻하게", vivid = "선명하게"
    var id: String { rawValue }

    func apply(_ im: CIImage) -> CIImage {
        switch self {
        case .original:
            return im
        case .bright:
            return im.applyingFilter("CIExposureAdjust", parameters: ["inputEV": 0.4])
        case .warm:
            return im.applyingFilter("CITemperatureAndTint", parameters: [
                "inputNeutral": CIVector(x: 6500, y: 0), "inputTargetNeutral": CIVector(x: 5200, y: 0)])
        case .vivid:
            return im.applyingFilter("CIVibrance", parameters: ["inputAmount": 0.5])
                .applyingFilter("CIColorControls", parameters: ["inputContrast": 1.08])
        }
    }
}

private let ciContext = CIContext()

/// 큰 화면용: 원본 데이터를 읽어 EXIF 방향을 맞추고, 화면 크기로 줄인 뒤 느낌을 입힌다.
func loadLarge(_ asset: PHAsset, maxPixel: CGFloat, look: Look) async -> CGImage? {
    let opts = PHImageRequestOptions()
    opts.isNetworkAccessAllowed = true
    opts.deliveryMode = .highQualityFormat
    let data: Data? = await withCheckedContinuation { cont in
        PHImageManager.default().requestImageDataAndOrientation(for: asset, options: opts) { d, _, _, _ in
            cont.resume(returning: d)
        }
    }
    guard let data, var im = CIImage(data: data, options: [.applyOrientationProperty: true]) else { return nil }
    let scale = min(1, maxPixel / max(im.extent.width, im.extent.height))
    if scale < 1 {
        im = im.applyingFilter("CILanczosScaleTransform", parameters: ["inputScale": scale, "inputAspectRatio": 1])
    }
    im = look.apply(im)
    return ciContext.createCGImage(im, from: im.extent)
}

/// 필름 띠용 작은 그림 (방향은 사진 보관함이 맞춰 준다)
func loadThumb(_ asset: PHAsset, side: CGFloat) async -> CGImage? {
    let opts = PHImageRequestOptions()
    opts.isNetworkAccessAllowed = true
    opts.deliveryMode = .highQualityFormat
    opts.resizeMode = .fast
    let size = CGSize(width: side, height: side)
    return await withCheckedContinuation { cont in
        PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFill, options: opts) { img, _ in
            cont.resume(returning: img?.cgImageOriented)
        }
    }
}

#if os(iOS)
import UIKit
extension UIImage {
    /// 방향까지 반영한 CGImage
    var cgImageOriented: CGImage? {
        if imageOrientation == .up { return cgImage }
        return UIGraphicsImageRenderer(size: size).image { _ in draw(at: .zero) }.cgImage
    }
}
#else
import AppKit
extension NSImage {
    var cgImageOriented: CGImage? { cgImage(forProposedRect: nil, context: nil, hints: nil) }
}
#endif

struct LargePhoto: View {
    let asset: PHAsset
    let look: Look
    @State private var image: CGImage?

    var body: some View {
        GeometryReader { geo in
            ZStack {
                if let image {
                    Image(decorative: image, scale: 1).resizable().scaledToFit()
                } else {
                    ProgressView()
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .task(id: "\(asset.localIdentifier)|\(look.rawValue)") {
                let px = max(geo.size.width, geo.size.height) * 2   // Retina
                image = await loadLarge(asset, maxPixel: px, look: look)
            }
        }
    }
}

struct Thumb: View {
    let asset: PHAsset
    let selected: Bool
    let liked: Bool
    @State private var image: CGImage?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Group {
                if let image {
                    Image(decorative: image, scale: 1).resizable().scaledToFill()
                } else {
                    Color.gray.opacity(0.3)
                }
            }
            .frame(width: 84, height: 84)
            .clipped()
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(selected ? Color.orange : .clear, lineWidth: 3))
            if liked {
                Image(systemName: "heart.fill").foregroundColor(.red).padding(4)
            }
        }
        .task(id: asset.localIdentifier) { image = await loadThumb(asset, side: 168) }
    }
}
