import SwiftUI

#if os(macOS)
import AppKit
#endif

enum AppSheet: Identifiable {
  case addAccount
  case compose
  case settings

  var id: String {
    switch self {
    case .addAccount: "addAccount"
    case .compose: "compose"
    case .settings: "settings"
    }
  }
}

struct RootView: View {
  var prepareForBootstrap: (() async -> Void)?

  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase
  @State private var sheet: AppSheet?
  @State private var searchTask: Task<Void, Never>?
  @State private var mailPollingTask: Task<Void, Never>?
  @State private var mailPollingShouldNotify = false
  @State private var preferredCompactColumn: NavigationSplitViewColumn = .content

  var body: some View {
    @Bindable var model = model

    NavigationSplitView(preferredCompactColumn: $preferredCompactColumn) {
      SidebarView(
        onAddAccount: { sheet = .addAccount },
        onShowMessages: { preferredCompactColumn = .content }
      )
    } content: {
      EmailListView(
        onCompose: { sheet = .compose },
        onSettings: { sheet = .settings },
        onShowDetail: { preferredCompactColumn = .detail }
      )
      .mailListNavigationTitle(model.navigationTitle)
      .searchable(text: $model.searchText, isPresented: $model.isSearchPresented, prompt: "Search")
    } detail: {
      EmailPreviewView(onCompose: { sheet = .compose })
    }
    .mailWindowToolbarLayout()
    .task {
      if let prepareForBootstrap {
        await prepareForBootstrap()
      }
      await model.bootstrap()
      configureMailPolling(for: scenePhase)
    }
    .onSubmit(of: .search) {
      Task { await model.refreshEmails() }
    }
    .onChange(of: model.searchText) { _, _ in
      searchTask?.cancel()
      searchTask = Task {
        try? await Task.sleep(for: .milliseconds(180))
        guard !Task.isCancelled else { return }
        await model.refreshEmails()
      }
    }
    .onChange(of: model.composeRequestCount) { _, _ in
      sheet = .compose
    }
    .onChange(of: model.settingsRequestCount) { _, _ in
      sheet = .settings
    }
    .onChange(of: model.notificationNavigationRequestCount) { _, _ in
      preferredCompactColumn = .detail
    }
    .onChange(of: scenePhase) { _, newPhase in
      configureMailPolling(for: newPhase)
    }
    .onDisappear {
      stopMailPolling()
    }
    .archiveDeleteCommand(model)
    .overlay(alignment: .bottom) {
      if let pendingArchive = model.pendingArchive {
        ArchiveUndoBanner(archive: pendingArchive) {
          model.undoPendingArchive()
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 18)
        .transition(.move(edge: .bottom).combined(with: .opacity))
      }
    }
    .animation(.snappy(duration: 0.24), value: model.pendingArchive?.id)
    .animation(.linear(duration: 0.18), value: model.pendingArchive?.secondsRemaining)
    .sheet(item: $sheet) { sheet in
      switch sheet {
      case .addAccount:
        AddAccountView()
          .environment(model)
      case .compose:
        ComposeView()
          .environment(model)
      case .settings:
        SettingsView()
          .environment(model)
      }
    }
    .alert("Server unavailable", isPresented: errorBinding) {
      Button("OK") {
        model.errorMessage = nil
      }
    } message: {
      Text(model.errorMessage ?? "")
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: {
        if case .addAccount? = sheet {
          return false
        }
        return model.errorMessage != nil
      },
      set: { isPresented in
        if !isPresented {
          model.errorMessage = nil
        }
      }
    )
  }

  private func configureMailPolling(for phase: ScenePhase) {
    #if os(iOS)
    switch phase {
    case .active:
      startMailPolling(shouldNotify: false)
    case .background:
      stopMailPolling()
      BackgroundMailRefreshController.shared.scheduleNextRefresh()
    case .inactive:
      stopMailPolling()
    @unknown default:
      startMailPolling(shouldNotify: false)
    }
    #else
    startMailPolling(shouldNotify: phase != .active)
    #endif
  }

  private func startMailPolling(shouldNotify: Bool) {
    guard mailPollingTask == nil || mailPollingShouldNotify != shouldNotify else { return }
    stopMailPolling()
    mailPollingShouldNotify = shouldNotify
    mailPollingTask = Task {
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(5 * 60))
        guard !Task.isCancelled else { return }
        let newEmailIDs = await model.pollAllMailForNewEmails()
        guard shouldNotify else { continue }
        let newEmails = await model.emailDetails(for: newEmailIDs)
        await PushNotificationController.shared.notifyNewEmails(newEmails)
      }
    }
  }

  private func stopMailPolling() {
    mailPollingTask?.cancel()
    mailPollingTask = nil
  }
}

private struct ArchiveUndoBanner: View {
  var archive: PendingArchiveNotification
  var onUndo: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "archivebox.fill")
        .font(.headline)
        .foregroundStyle(.secondary)
        .frame(width: 24, height: 24)

      VStack(alignment: .leading, spacing: 2) {
        Text("Archive pending")
          .font(.subheadline.weight(.semibold))
        Text(detailText)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      Spacer(minLength: 12)

      Text("\(archive.secondsRemaining)s")
        .font(.caption.monospacedDigit().weight(.semibold))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.quaternary, in: Capsule())

      Button("Undo", action: onUndo)
        .buttonStyle(.bordered)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .frame(maxWidth: 460)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .shadow(color: .black.opacity(0.18), radius: 18, x: 0, y: 10)
  }

  private var detailText: String {
    let subject = archive.subject.trimmingCharacters(in: .whitespacesAndNewlines)
    if subject.isEmpty {
      return archive.senderName
    }
    return subject
  }
}

private extension View {
  @ViewBuilder
  func mailWindowToolbarLayout() -> some View {
    #if os(macOS)
    background(MacWindowToolbarLayoutConfigurator())
    #else
    self
    #endif
  }

  @ViewBuilder
  func mailListNavigationTitle(_ title: String) -> some View {
    #if os(iOS)
    navigationTitle("")
    #else
    navigationTitle(title)
    #endif
  }

  @ViewBuilder
  func archiveDeleteCommand(_ model: AppModel) -> some View {
    #if os(macOS)
    onDeleteCommand {
      guard model.shortcut(for: .archive).isDeleteWithoutModifiers else { return }
      Task { await model.archiveSelectedEmail() }
    }
    #else
    self
    #endif
  }
}

#if os(macOS)
private struct MacWindowToolbarLayoutConfigurator: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView {
    let view = NSView(frame: .zero)
    configureWhenAttached(view)
    return view
  }

  func updateNSView(_ view: NSView, context: Context) {
    configureWhenAttached(view)
  }

  private func configureWhenAttached(_ view: NSView) {
    DispatchQueue.main.async {
      guard let window = view.window else { return }
      window.styleMask.remove(.fullSizeContentView)
      window.titlebarAppearsTransparent = false
      window.titleVisibility = .hidden
      window.toolbarStyle = .unified
    }
  }
}
#endif
