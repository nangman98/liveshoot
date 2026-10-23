// swift-tools-version: 5.9

// Swift Playgrounds(iPad)·Xcode 앱 프로젝트. 사진 보관함에 새로 들어온 사진을 바로 보여 준다.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "LiveShoot",
    platforms: [
        .iOS("16.0")
    ],
    products: [
        .iOSApplication(
            name: "LiveShoot",
            targets: ["AppModule"],
            bundleIdentifier: "com.nangman98.liveshoot",
            displayVersion: "0.1",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .camera),
            accentColor: .presetColor(.orange),
            supportedDeviceFamilies: [
                .pad,
                .phone
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ],
            capabilities: [
                .photoLibrary(purposeString: "카메라 앱이 보낸 사진을 실시간으로 보여 주고 하트를 즐겨찾기로 표시하려고 사진 보관함을 씁니다.")
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
