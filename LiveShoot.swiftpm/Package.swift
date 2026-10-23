// swift-tools-version: 5.9

// Swift Playgrounds(iPad)·Xcode 앱 프로젝트. a7 IV(FTP)·GR III(Wi-Fi)·사진 보관함으로 들어온 사진을 바로 보정해 보여 준다.

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
            displayVersion: "0.2",
            bundleVersion: "2",
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
                .photoLibrary(purposeString: "새로 들어온 사진을 보여 주고, 보정본을 LiveShoot 앨범에 저장하려고 사진 보관함을 씁니다."),
                .localNetwork(purposeString: "a7 IV의 FTP 전송을 받고 GR III Wi-Fi에서 사진을 가져오려고 로컬 네트워크를 씁니다.")
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
