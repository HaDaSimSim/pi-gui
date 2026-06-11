import PiCore
import SwiftUI

// Git tab: branch header, working-tree changes (with status colors), branch list, and a recent
// commit graph shown by default. Tapping a commit opens a detail sheet (message + numstat).
struct GitPanelView: View {
  let cwd: String
  @State private var info = GitInfo()
  @State private var loaded = false
  @State private var loading = false
  @State private var detail: GitCommitDetail?
  @State private var showBranches = false

  var body: some View {
    Group {
      if !loaded {
        ProgressView().frame(maxWidth: .infinity).task { reload() }
      } else if !info.isRepo {
        ContentUnavailableView("Not a git repository", systemImage: "folder.badge.questionmark")
      } else {
        content
      }
    }
    .sheet(
      item: Binding(
        get: { detail.map { CommitDetailBox($0) } }, set: { if $0 == nil { detail = nil } })
    ) { box in
      CommitDetailView(detail: box.detail) { detail = nil }
    }
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 12) {
      header
      changesSection
      if info.branches.count > 1 { branchesSection }
      commitsSection
    }
  }

  private var header: some View {
    HStack(spacing: 6) {
      Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary)
      VStack(alignment: .leading, spacing: 0) {
        Text(info.branch ?? "detached \(info.detachedHead ?? "")").fontWeight(.semibold)
        if let up = info.upstream {
          Text(up).font(.caption2).foregroundStyle(.tertiary)
        }
      }
      if info.ahead > 0 { Text("↑\(info.ahead)").font(.caption).foregroundStyle(Theme.success) }
      if info.behind > 0 { Text("↓\(info.behind)").font(.caption).foregroundStyle(Theme.streaming) }
      Spacer()
      Button {
        reload()
      } label: {
        Image(systemName: "arrow.clockwise")
          .rotationEffect(.degrees(loading ? 360 : 0))
          .animation(
            loading ? .linear(duration: 0.8).repeatForever(autoreverses: false) : .default,
            value: loading)
      }
      .buttonStyle(.borderless)
    }
    .font(.callout)
  }

  @ViewBuilder private var changesSection: some View {
    if info.staged.isEmpty && info.unstaged.isEmpty && info.untracked.isEmpty {
      Label("Working tree clean", systemImage: "checkmark.circle")
        .font(.caption).foregroundStyle(.secondary)
    } else {
      fileGroup("Staged", info.staged)
      fileGroup("Unstaged", info.unstaged)
      fileGroup("Untracked", info.untracked)
    }
  }

  @ViewBuilder private func fileGroup(_ title: String, _ files: [GitFileChange]) -> some View {
    if !files.isEmpty {
      VStack(alignment: .leading, spacing: 3) {
        Text("\(title) · \(files.count)").font(.caption2).foregroundStyle(.secondary)
        ForEach(files) { f in
          HStack(spacing: 6) {
            Text(f.code).font(.system(.caption2, design: .monospaced))
              .foregroundStyle(codeColor(f.code)).frame(width: 12)
            Text(f.path).font(.system(.caption, design: .monospaced))
              .lineLimit(1).truncationMode(.middle)
          }
        }
      }
    }
  }

  private func codeColor(_ c: String) -> Color {
    switch c {
    case "M": return Theme.streaming
    case "A": return Theme.success
    case "D": return Theme.danger
    case "R": return Theme.info
    default: return .secondary
    }
  }

  private var branchesSection: some View {
    DisclosureGroup(isExpanded: $showBranches) {
      ForEach(info.branches) { b in
        HStack(spacing: 6) {
          Circle().fill(b.current ? Theme.success : Color.secondary.opacity(0.4))
            .frame(width: 6, height: 6)
          Text(b.name).font(.caption)
          if let up = b.upstream { Text(up).font(.caption2).foregroundStyle(.tertiary) }
          Spacer()
        }
      }
    } label: {
      Text("Branches · \(info.branches.count)").font(.caption).foregroundStyle(.secondary)
    }
  }

  private var commitsSection: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("Commits").font(.caption).foregroundStyle(.secondary).padding(.bottom, 4)
      ForEach(Array(info.commits.enumerated()), id: \.element.id) { idx, c in
        CommitRow(commit: c, isLast: idx == info.commits.count - 1)
          .contentShape(Rectangle())
          .onTapGesture {
            if let d = GitInfo.commitDetail(cwd: cwd, hash: c.hash) { detail = d }
          }
      }
    }
  }

  private func reload() {
    loading = true
    DispatchQueue.global(qos: .userInitiated).async {
      let fresh = GitInfo.load(cwd: cwd)
      DispatchQueue.main.async {
        info = fresh
        loaded = true
        loading = false
      }
    }
  }
}

// One commit row with a simple lane (dot + connector). Merge commits get a violet ring.
private struct CommitRow: View {
  let commit: GitCommit
  let isLast: Bool
  @State private var hovering = false
  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      VStack(spacing: 0) {
        ZStack {
          if commit.isMerge {
            Circle().stroke(Theme.accentViolet, lineWidth: 2).frame(width: 9, height: 9)
          } else {
            Circle().fill(Theme.info).frame(width: 8, height: 8)
          }
        }
        .frame(height: 14)
        if !isLast {
          Rectangle().fill(Color.secondary.opacity(0.3)).frame(width: 1.5)
            .frame(maxHeight: .infinity)
        }
      }
      .frame(width: 10)

      VStack(alignment: .leading, spacing: 1) {
        Text(commit.subject).font(.caption).lineLimit(2)
        HStack(spacing: 5) {
          Text(commit.shortHash).font(.system(.caption2, design: .monospaced)).foregroundStyle(
            .tertiary)
          Text(commit.author).font(.caption2).foregroundStyle(.tertiary)
          Text(commit.relTime).font(.caption2).foregroundStyle(.tertiary)
        }
        if !commit.refs.isEmpty {
          HStack(spacing: 4) {
            ForEach(commit.refs, id: \.self) { ref in
              Text(ref).font(.system(size: 9, design: .monospaced))
                .padding(.horizontal, 5).padding(.vertical, 1)
                .background(Theme.info.opacity(0.15), in: Capsule())
                .foregroundStyle(Theme.info)
            }
          }
        }
      }
      .padding(.bottom, 8)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 4).padding(.vertical, 2)
    .background(
      hovering ? Color.secondary.opacity(0.1) : .clear, in: RoundedRectangle(cornerRadius: 6)
    )
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

// Identifiable box so GitCommitDetail can drive a .sheet(item:).
private struct CommitDetailBox: Identifiable {
  let detail: GitCommitDetail
  init(_ d: GitCommitDetail) { self.detail = d }
  var id: String { detail.hash }
}

private struct CommitDetailView: View {
  let detail: GitCommitDetail
  let onClose: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(detail.subject).font(.headline).lineLimit(2)
        Spacer()
        Button("Done", action: onClose).keyboardShortcut(.cancelAction)
      }
      .padding(.horizontal, 16).padding(.vertical, 12)
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          VStack(alignment: .leading, spacing: 2) {
            Text("\(detail.shortHash) · \(detail.author) <\(detail.authorEmail)>")
              .font(.caption).foregroundStyle(.secondary)
            Text(detail.relTime).font(.caption2).foregroundStyle(.tertiary)
            if !detail.parents.isEmpty {
              Text(
                "parents: \(detail.parents.map { String($0.prefix(8)) }.joined(separator: ", "))"
              )
              .font(.caption2).foregroundStyle(.tertiary)
            }
          }
          if !detail.body.isEmpty {
            Text(detail.body).font(.system(.caption, design: .monospaced))
              .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
          }
          Divider()
          HStack(spacing: 10) {
            Text("\(detail.files.count) files").font(.caption).foregroundStyle(.secondary)
            Text("+\(detail.insertions)").font(.caption).foregroundStyle(Theme.success)
            Text("−\(detail.deletions)").font(.caption).foregroundStyle(Theme.danger)
          }
          ForEach(detail.files) { f in
            HStack(spacing: 8) {
              Text("+\(f.added)").font(.system(.caption2, design: .monospaced)).foregroundStyle(
                Theme.success
              ).frame(width: 38, alignment: .trailing)
              Text("−\(f.deleted)").font(.system(.caption2, design: .monospaced)).foregroundStyle(
                Theme.danger
              ).frame(width: 38, alignment: .trailing)
              Text(f.path).font(.system(.caption, design: .monospaced)).lineLimit(1).truncationMode(
                .middle)
              Spacer(minLength: 0)
            }
          }
        }
        .padding(16)
      }
    }
    .frame(minWidth: 520, idealWidth: 680, minHeight: 360, idealHeight: 560)
  }
}
