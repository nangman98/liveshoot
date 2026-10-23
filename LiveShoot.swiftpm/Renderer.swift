import CoreImage
import Foundation
import ImageIO

/// 한 장의 보정값. 늘 원본에 처음부터 다시 입힌다 (원본 불변).
struct Edit: Codable, Hashable {
    var autoExposure = true
    var exposure = 0.0      // EV, -3...3 (자동 노출 위에 더함)
    var contrast = 0.0      // -100...100
    var highlights = 0.0    // -100...100
    var shadows = 0.0       // -100...100
    var temperature = 0.0   // -100...100, + 따뜻하게
    var tint = 0.0          // -100...100, + 자주
    var vibrance = 0.0      // -100...100
    var saturation = 0.0    // -100...100
}

enum Renderer {
    static let context = CIContext(options: [.cacheIntermediates: false])

    /// 파일을 EXIF 방향을 맞춰 긴 변 maxPixel 이하로 읽는다. maxPixel 0이면 원본 크기.
    static func load(url: URL, maxPixel: Int) -> CIImage? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return load(src, maxPixel: maxPixel)
    }

    static func load(data: Data, maxPixel: Int) -> CIImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        return load(src, maxPixel: maxPixel)
    }

    private static func load(_ src: CGImageSource, maxPixel: Int) -> CIImage? {
        var edge = maxPixel
        if edge == 0, let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] {
            edge = max(p[kCGImagePropertyPixelWidth] as? Int ?? 0, p[kCGImagePropertyPixelHeight] as? Int ?? 0)
        }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: max(edge, 1),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return CIImage(cgImage: cg)
    }

    /// 자동 노출: 64 px로 줄인 그림의 log 평균 휘도를 중간 회색(선형 0.18)에 맞추는 EV. ±2.5로 자름.
    static func autoEV(_ im: CIImage) -> Double {
        let s = 64 / max(im.extent.width, im.extent.height)
        let small = im.transformed(by: CGAffineTransform(scaleX: s, y: s))
        let w = Int(small.extent.width.rounded(.up)), h = Int(small.extent.height.rounded(.up))
        guard w > 0, h > 0, let lin = CGColorSpace(name: CGColorSpace.linearSRGB) else { return 0 }
        var px = [Float](repeating: 0, count: w * h * 4)
        context.render(small, toBitmap: &px, rowBytes: w * 16,
                       bounds: CGRect(x: small.extent.minX, y: small.extent.minY, width: CGFloat(w), height: CGFloat(h)),
                       format: .RGBAf, colorSpace: lin)
        var sum = 0.0
        for i in stride(from: 0, to: px.count, by: 4) {
            let y = 0.2126 * Double(px[i]) + 0.7152 * Double(px[i + 1]) + 0.0722 * Double(px[i + 2])
            sum += log(max(y, 1e-4))
        }
        let logAvg = exp(sum / Double(w * h))
        return min(2.5, max(-2.5, log2(0.18 / logAvg)))
    }

    static func apply(_ e: Edit, autoEV: Double, to im: CIImage) -> CIImage {
        var x = im
        let ev = e.exposure + (e.autoExposure ? autoEV : 0)
        if ev != 0 {
            x = x.applyingFilter("CIExposureAdjust", parameters: [kCIInputEVKey: ev])
        }
        if e.highlights < 0 || e.shadows != 0 {
            x = x.applyingFilter("CIHighlightShadowAdjust", parameters: [
                "inputHighlightAmount": 1 + min(0, e.highlights) / 100,
                "inputShadowAmount": e.shadows / 100,
            ])
        }
        if e.highlights > 0 {
            let up = 0.12 * e.highlights / 100
            x = x.applyingFilter("CIToneCurve", parameters: [
                "inputPoint0": CIVector(x: 0, y: 0), "inputPoint1": CIVector(x: 0.25, y: 0.25),
                "inputPoint2": CIVector(x: 0.5, y: 0.5), "inputPoint3": CIVector(x: 0.75, y: 0.75 + up),
                "inputPoint4": CIVector(x: 1, y: 1)])
        }
        if e.temperature != 0 || e.tint != 0 {
            // 원래 6500 K로 본 빛을 더 낮은(높은) 색온도로 보면 따뜻(차갑)해진다
            x = x.applyingFilter("CITemperatureAndTint", parameters: [
                "inputNeutral": CIVector(x: 6500, y: 0),
                "inputTargetNeutral": CIVector(x: 6500 - 30 * e.temperature, y: -e.tint)])   // Core Image는 +가 초록이라 뒤집음
        }
        if e.vibrance != 0 {
            x = x.applyingFilter("CIVibrance", parameters: ["inputAmount": e.vibrance / 100])
        }
        if e.contrast != 0 || e.saturation != 0 {
            x = x.applyingFilter("CIColorControls", parameters: [
                kCIInputContrastKey: 1 + e.contrast / 200,
                kCIInputSaturationKey: 1 + e.saturation / 100,
                kCIInputBrightnessKey: 0])
        }
        return x.cropped(to: im.extent)
    }

    static func cgImage(_ im: CIImage) -> CGImage? {
        context.createCGImage(im, from: im.extent)
    }

    static func thumbnail(_ im: CIImage, side: CGFloat) -> CGImage? {
        let s = side / max(im.extent.width, im.extent.height)
        return cgImage(im.transformed(by: CGAffineTransform(scaleX: s, y: s)))
    }

    /// 내보내기용 JPEG (sRGB)
    static func jpeg(_ im: CIImage, quality: Double) -> Data? {
        guard let srgb = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let key = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        return context.jpegRepresentation(of: im, colorSpace: srgb, options: [key: quality])
    }
}
