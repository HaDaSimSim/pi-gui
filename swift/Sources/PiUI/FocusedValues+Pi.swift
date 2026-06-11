import SwiftUI

// Publish the active session's runtime via FocusedValues so App-level commands
// (menu items, keyboard shortcuts) can access whichever session has focus.

extension FocusedValues {
  @Entry var activeRuntime: RuntimeSession?
}
