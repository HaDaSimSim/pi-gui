import AppKit

// Generates a macOS .iconset of a serif "π" glyph on a rounded dark background, then leaves
// PNGs for iconutil to assemble. Run: swift make-icon.swift <outputDir>
let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

func render(_ px: Int) -> Data? {
    let size = NSSize(width: px, height: px)
    let img = NSImage(size: size)
    img.lockFocus()
    guard let ctx = NSGraphicsContext.current?.cgContext else { img.unlockFocus(); return nil }

    // Rounded-rect background with a subtle vertical gradient (macOS app-icon feel).
    let inset = CGFloat(px) * 0.08
    let rect = CGRect(x: inset, y: inset, width: CGFloat(px) - inset*2, height: CGFloat(px) - inset*2)
    let radius = rect.width * 0.2237   // Apple squircle-ish corner ratio
    let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    let grad = NSGradient(colors: [
        NSColor(calibratedRed: 0.13, green: 0.13, blue: 0.15, alpha: 1),
        NSColor(calibratedRed: 0.04, green: 0.04, blue: 0.05, alpha: 1),
    ])
    grad?.draw(in: path, angle: -90)

    // Serif π, near-white, centered.
    let fontSize = CGFloat(px) * 0.62
    let font = NSFont(name: "Times New Roman", size: fontSize)
        ?? NSFont(name: "Georgia", size: fontSize)
        ?? NSFont.systemFont(ofSize: fontSize)
    let para = NSMutableParagraphStyle(); para.alignment = .center
    let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: NSColor(calibratedWhite: 0.97, alpha: 1),
        .paragraphStyle: para,
    ]
    let s = NSAttributedString(string: "\u{03C0}", attributes: attrs)
    let textSize = s.size()
    let origin = NSPoint(x: (CGFloat(px) - textSize.width)/2,
                         y: (CGFloat(px) - textSize.height)/2 - CGFloat(px) * 0.01)
    s.draw(at: origin)

    img.unlockFocus()
    guard let tiff = img.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return nil }
    _ = ctx
    return png
}

// macOS iconset required sizes (1x and 2x).
let specs: [(name: String, px: Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32),
    ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256),
    ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024),
]
for spec in specs {
    if let data = render(spec.px) {
        try? data.write(to: URL(fileURLWithPath: "\(outDir)/\(spec.name).png"))
    }
}
print("wrote iconset to \(outDir)")
