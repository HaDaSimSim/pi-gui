// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PiSwift",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "PiSwift",
            path: "Sources/PiSwift",
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
