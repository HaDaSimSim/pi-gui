import SwiftUI

/// A drop-in DisclosureGroup replacement that animates height transitions on macOS.
/// The standard DisclosureGroup does NOT animate content height changes, causing
/// content to "pop" in/out. This view uses `withAnimation` on the state toggle and
/// `.clipped()` so SwiftUI properly interpolates the frame height.
struct AnimatedDisclosureGroup<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content
  @State private var expanded = false

  init(title: String, expanded: Bool = false, @ViewBuilder content: () -> Content) {
    self.title = title
    self._expanded = State(initialValue: expanded)
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button {
        withAnimation(.easeInOut(duration: 0.25)) { expanded.toggle() }
      } label: {
        HStack(spacing: 4) {
          Image(systemName: "chevron.right")
            .font(.system(size: 9, weight: .semibold))
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .animation(.easeInOut(duration: 0.2), value: expanded)
          Text(title)
          Spacer()
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      if expanded {
        VStack(alignment: .leading, spacing: 4) {
          content
        }
        .padding(.leading, 16)
        .padding(.top, 4)
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .clipped()
  }
}
