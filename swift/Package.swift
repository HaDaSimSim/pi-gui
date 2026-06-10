// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PiSwift",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "PiCore", targets: ["PiCore"]),
        .library(name: "PiUI", targets: ["PiUI"]),
        .executable(name: "PiMac", targets: ["PiMac"]),
        .library(name: "PiMobile", targets: ["PiMobile"]),
        .executable(name: "PiRelay", targets: ["PiRelay"]),
        .executable(name: "PiPushGateway", targets: ["PiPushGateway"]),
    ],
    targets: [
        .target(
            name: "PiCore",
            path: "Sources/PiCore",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "PiUI",
            dependencies: ["PiCore"],
            path: "Sources/PiUI",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "PiMac",
            dependencies: ["PiCore", "PiUI"],
            path: "Sources/PiMac",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "PiMobile",
            dependencies: ["PiCore", "PiUI"],
            path: "Sources/PiMobile",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "PiRelay",
            dependencies: ["PiCore"],
            path: "Sources/PiRelay",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "PiPushGateway",
            dependencies: ["PiCore"],
            path: "Sources/PiPushGateway",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
