import AppKit
import PiCore
import SwiftUI

// SessionWindowController is no longer used in the single-window NavigationSplitView
// architecture. Kept as a minimal stub for backward compatibility with any external
// references (bundle scripts, etc.). The main window is now a pure SwiftUI WindowGroup.

@MainActor
public final class SessionWindowController: NSWindowController {
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not implemented") }
}
