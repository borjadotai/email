import Foundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

struct SettingsView: View {
  @State private var selectedTab: SettingsTab = .sync
  #if os(macOS)
  var softwareUpdateController: SoftwareUpdateController? = nil
  #endif

  var body: some View {
    #if os(macOS)
    HStack(spacing: 0) {
      SettingsSidebar(selectedTab: $selectedTab)
        .frame(width: 210)

      Divider()

      settingsPane(for: selectedTab)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .frame(minWidth: 860, minHeight: 620)
    #else
    NavigationStack {
      List(SettingsTab.allCases) { tab in
        NavigationLink(value: tab) {
          SettingsSectionLabel(tab: tab)
        }
      }
      .navigationTitle("Settings")
      .navigationDestination(for: SettingsTab.self) { tab in
        settingsPane(for: tab)
          .navigationTitle(tab.title)
          .navigationBarTitleDisplayMode(.inline)
      }
    }
    #endif
  }

  @ViewBuilder
  private func settingsPane(for tab: SettingsTab) -> some View {
    switch tab {
    case .sync:
      SyncStorageSettingsPane()
    case .accounts:
      AccountProfileSettingsPane()
    case .general:
      generalSettingsPane
    case .server:
      ServerConnectionSettingsPane()
    case .shortcuts:
      ShortcutSettingsPane()
    }
  }

  private var generalSettingsPane: some View {
    #if os(macOS)
    GeneralPreferencesPane(softwareUpdateController: softwareUpdateController)
    #else
    GeneralPreferencesPane()
    #endif
  }
}

private enum SettingsTab: String, CaseIterable, Identifiable {
  case sync
  case accounts
  case general
  case server
  case shortcuts

  var id: String { rawValue }

  var title: String {
    switch self {
    case .sync: "Sync & Storage"
    case .accounts: "Accounts"
    case .general: "General"
    case .server: "Server"
    case .shortcuts: "Shortcuts"
    }
  }

  var subtitle: String {
    switch self {
    case .sync: "Import progress and disk usage"
    case .accounts: "Names, avatars, and account settings"
    case .general: "Appearance, icon, and updates"
    case .server: "Connection and provider status"
    case .shortcuts: "Keyboard actions"
    }
  }

  var systemImage: String {
    switch self {
    case .sync: "externaldrive.badge.icloud"
    case .accounts: "person.crop.square"
    case .general: "gearshape"
    case .server: "server.rack"
    case .shortcuts: "keyboard"
    }
  }
}

#if os(macOS)
private struct SettingsSidebar: View {
  @Binding var selectedTab: SettingsTab

  var body: some View {
    List(SettingsTab.allCases, selection: $selectedTab) { tab in
      SettingsSectionLabel(tab: tab)
        .tag(tab)
    }
    .listStyle(.sidebar)
    .navigationTitle("Settings")
  }
}
#endif

private struct SettingsSectionLabel: View {
  var tab: SettingsTab

  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(tab.title)
          .font(.headline)
        Text(tab.subtitle)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(2)
      }
    } icon: {
      Image(systemName: tab.systemImage)
        .symbolRenderingMode(.hierarchical)
        .foregroundStyle(.secondary)
    }
  }
}

private struct SettingsPaneScroll<Content: View>: View {
  var title: String
  var subtitle: String?
  @ViewBuilder var content: Content

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        VStack(alignment: .leading, spacing: 4) {
          Text(title)
            .font(.largeTitle.bold())
          if let subtitle {
            Text(subtitle)
              .font(.callout)
              .foregroundStyle(.secondary)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        content
      }
      .padding(settingsPanePadding)
      .frame(maxWidth: 820, alignment: .leading)
    }
    #if os(macOS)
    .background(.background)
    #endif
  }

  private var settingsPanePadding: EdgeInsets {
    #if os(iOS)
    EdgeInsets(top: 20, leading: 16, bottom: 28, trailing: 16)
    #else
    EdgeInsets(top: 28, leading: 32, bottom: 32, trailing: 32)
    #endif
  }
}

private struct SettingsGroup<Content: View>: View {
  var title: String
  var systemImage: String
  @ViewBuilder var content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label(title, systemImage: systemImage)
        .font(.headline)

      VStack(alignment: .leading, spacing: 0) {
        content
      }
      .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(Color.secondary.opacity(0.16), lineWidth: 1)
      }
    }
  }
}

private struct SettingsRow<Content: View>: View {
  var title: String
  var detail: String?
  @ViewBuilder var content: Content

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 16) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.subheadline.weight(.medium))
        if let detail {
          Text(detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      Spacer(minLength: 16)

      content
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
  }
}

private struct SettingsDivider: View {
  var body: some View {
    Divider()
      .padding(.leading, 14)
  }
}

private struct SyncStorageSettingsPane: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    SettingsPaneScroll(
      title: "Sync & Storage",
      subtitle: "Track account imports, local mail storage, and history coverage."
    ) {
      SyncStorageOverview(accounts: model.accounts)

      if model.accounts.isEmpty {
        ContentUnavailableView("No Accounts", systemImage: "person.crop.square")
          .frame(maxWidth: .infinity)
          .padding(.vertical, 40)
      } else {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(model.accounts) { account in
            AccountSyncStorageCard(account: account)
          }
        }
      }

      if let statusMessage = model.statusMessage {
        Text(statusMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .task {
      await model.refreshAccountDiagnostics()
    }
  }
}

private struct SyncStorageOverview: View {
  var accounts: [MailAccount]

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
      StorageMetricTile(
        title: "Storage Est.",
        value: ByteCountFormatter.emailStorageString(totalStoredBytes),
        systemImage: "internaldrive"
      )
      StorageMetricTile(
        title: "Messages",
        value: totalMessages.formatted(),
        systemImage: "envelope"
      )
      StorageMetricTile(
        title: "Downloaded Files",
        value: downloadedAttachments.formatted(),
        systemImage: "paperclip"
      )
      StorageMetricTile(
        title: "Active Imports",
        value: activeImports.formatted(),
        systemImage: "arrow.down.circle"
      )
    }
  }

  private var totalStoredBytes: Int {
    accounts.reduce(0) { $0 + ($1.stats?.localStorageBytes ?? 0) }
  }

  private var totalMessages: Int {
    accounts.reduce(0) { $0 + ($1.stats?.totalCount ?? 0) }
  }

  private var downloadedAttachments: Int {
    accounts.reduce(0) { $0 + ($1.stats?.downloadedAttachmentCount ?? 0) }
  }

  private var activeImports: Int {
    accounts.filter(\.isImportingMail).count
  }
}

private struct StorageMetricTile: View {
  var title: String
  var value: String
  var systemImage: String

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.title3)
        .foregroundStyle(.secondary)
        .frame(width: 28)

      VStack(alignment: .leading, spacing: 2) {
        Text(value)
          .font(.headline.monospacedDigit())
          .lineLimit(1)
          .minimumScaleFactor(0.8)
        Text(title)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      Spacer(minLength: 0)
    }
    .padding(14)
    .background(.quaternary.opacity(0.28), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(Color.secondary.opacity(0.14), lineWidth: 1)
    }
  }
}

private struct AccountSyncStorageCard: View {
  @Environment(AppModel.self) private var model
  var account: MailAccount

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        AvatarView(
          name: account.displayName,
          email: account.email,
          urlString: account.avatarURL,
          size: 42
        )

        VStack(alignment: .leading, spacing: 4) {
          HStack(spacing: 8) {
            Text(account.displayName)
              .font(.headline)
              .lineLimit(1)
            AccountStatusBadge(status: account.status)
          }
          Text(account.email)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }

        Spacer(minLength: 10)

        ProviderBadge(provider: account.provider)
      }

      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          syncStateIcon
          Text(syncStateTitle)
            .font(.subheadline.weight(.semibold))
          Spacer(minLength: 8)
          if let updatedText {
            Text(updatedText)
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }

        if account.isImportingMail {
          ProgressView()
            .progressViewStyle(.linear)
        } else {
          ProgressView(value: account.importStatus?.isComplete == true ? 1 : 0.35)
            .progressViewStyle(.linear)
            .tint(account.importStatus?.isComplete == true ? .green : .orange)
        }

        Text(syncDetailText)
          .font(.caption)
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      LazyVGrid(columns: [GridItem(.adaptive(minimum: 116), spacing: 10)], spacing: 10) {
        AccountStatPill(title: "Messages", value: (account.stats?.totalCount ?? 0).formatted(), systemImage: "envelope")
        AccountStatPill(title: "Unread", value: (account.stats?.unreadCount ?? 0).formatted(), systemImage: "envelope.badge")
        AccountStatPill(title: "Files", value: (account.stats?.downloadedAttachmentCount ?? 0).formatted(), systemImage: "paperclip")
        AccountStatPill(
          title: "Stored Est.",
          value: ByteCountFormatter.emailStorageString(account.stats?.localStorageBytes ?? 0),
          systemImage: "internaldrive"
        )
      }

      HStack(spacing: 10) {
        Button {
          Task { await model.syncAccount(account, includeDiagnostics: true) }
        } label: {
          Label("Sync Recent", systemImage: "arrow.clockwise")
        }
        .disabled(account.status != "connected" || model.syncingAccountID == account.id || account.isImportingMail)

        Button {
          Task { await model.startFullHistorySync(account) }
        } label: {
          Label(fullHistoryButtonTitle, systemImage: "arrow.down.to.line.compact")
        }
        .disabled(account.status != "connected" || model.backfillingAccountID != nil || account.isImportingMail)

        if model.syncingAccountID == account.id || model.backfillingAccountID == account.id {
          ProgressView()
            .controlSize(.small)
        }
      }
      .buttonStyle(.bordered)
    }
    .padding(16)
    .background(.quaternary.opacity(0.24), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(Color.secondary.opacity(0.14), lineWidth: 1)
    }
  }

  @ViewBuilder
  private var syncStateIcon: some View {
    if account.isImportingMail {
      ProgressView()
        .controlSize(.small)
    } else {
      Image(systemName: syncStateSystemImage)
        .foregroundStyle(syncStateColor)
    }
  }

  private var syncStateTitle: String {
    guard let status = account.importStatus else {
      return account.status == "connected" ? "Ready to sync" : "Not connected"
    }
    if status.isFailed {
      return "Import needs attention"
    }
    if status.isImporting {
      return "Downloading mail"
    }
    if status.isComplete && status.isFullHistory {
      return "Full history synced"
    }
    if status.isComplete {
      return "Selected window synced"
    }
    if status.isPartial {
      return "More history available"
    }
    return status.title
  }

  private var syncDetailText: String {
    guard let status = account.importStatus else {
      return "No import progress has been recorded for this account yet."
    }
    var parts = [status.detailText(account: nil), status.attachmentText]
    if let stats = account.stats, stats.localStorageBytes > 0 {
      parts.append("\(ByteCountFormatter.emailStorageString(stats.localStorageBytes)) estimated locally")
    }
    return parts.joined(separator: " - ")
  }

  private var updatedText: String? {
    guard let updatedAt = account.importStatus?.updatedAt ?? account.lastSyncAt else { return nil }
    return MailDateFormatter.listTimestamp(updatedAt)
  }

  private var syncStateSystemImage: String {
    guard let status = account.importStatus else { return "circle" }
    if status.isFailed { return "exclamationmark.triangle.fill" }
    if status.isComplete { return "checkmark.circle.fill" }
    if status.isPartial { return "pause.circle.fill" }
    return "circle"
  }

  private var syncStateColor: Color {
    guard let status = account.importStatus else { return .secondary }
    if status.isFailed { return .red }
    if status.isComplete { return .green }
    if status.isPartial { return .orange }
    return .secondary
  }

  private var fullHistoryButtonTitle: String {
    if account.importStatus?.isFullHistory == true {
      return "Continue Full Sync"
    }
    return "Sync Full History"
  }
}

private struct AccountStatPill: View {
  var title: String
  var value: String
  var systemImage: String

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: systemImage)
        .foregroundStyle(.secondary)
        .frame(width: 18)
      VStack(alignment: .leading, spacing: 1) {
        Text(value)
          .font(.subheadline.weight(.semibold).monospacedDigit())
          .lineLimit(1)
          .minimumScaleFactor(0.78)
        Text(title)
          .font(.caption2)
          .foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 9)
    .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
}

private struct ProviderBadge: View {
  var provider: MailProvider

  var body: some View {
    Label(provider.displayName, systemImage: provider.systemImage)
      .font(.caption.weight(.medium))
      .foregroundStyle(.secondary)
      .labelStyle(.titleAndIcon)
      .padding(.horizontal, 9)
      .padding(.vertical, 5)
      .background(Color.secondary.opacity(0.08), in: Capsule())
  }
}

private struct AccountProfileSettingsPane: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    SettingsPaneScroll(
      title: "Accounts",
      subtitle: "Edit account identity, avatars, and local sync preferences."
    ) {
      if model.accounts.isEmpty {
        ContentUnavailableView("No Accounts", systemImage: "person.crop.square")
          .frame(maxWidth: .infinity)
          .padding(.vertical, 40)
      } else {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(model.accounts) { account in
            AccountProfileEditorCard(account: account)
          }
        }
      }
    }
  }
}

private struct AccountProfileEditorCard: View {
  @Environment(AppModel.self) private var model
  var account: MailAccount

  @State private var displayName = ""
  @State private var avatarURL = ""
  @State private var syncHistory = true
  @State private var loadedAccountID: String?
  @State private var selectedAvatarItem: PhotosPickerItem?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        AvatarView(
          name: account.displayName,
          email: account.email,
          urlString: account.avatarURL,
          size: 44
        )

        VStack(alignment: .leading, spacing: 3) {
          Text(account.displayName)
            .font(.headline)
            .lineLimit(1)
          Text(account.email)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }

        Spacer(minLength: 10)

        AccountStatusBadge(status: account.status)
      }

      accountImageSettings

      TextField("Display name", text: $displayName)
        #if os(iOS)
        .textInputAutocapitalization(.words)
        #endif

      TextField("Image URL", text: avatarURLFieldBinding)
        #if os(iOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        #endif
        .autocorrectionDisabled()
        .disabled(isEmbeddedAvatar)

      Toggle("Keep syncing historical mail", isOn: $syncHistory)

      LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 10)], spacing: 10) {
        AccountStatPill(title: "Provider", value: account.provider.displayName, systemImage: account.provider.systemImage)
        AccountStatPill(title: "Auth", value: account.authType, systemImage: "key")
        AccountStatPill(title: "Last Sync", value: lastSyncText, systemImage: "clock")
        AccountStatPill(
          title: "Storage Est.",
          value: ByteCountFormatter.emailStorageString(account.stats?.localStorageBytes ?? 0),
          systemImage: "internaldrive"
        )
      }

      AccountMailboxSummary(account: account)

      HStack(spacing: 10) {
        Button {
          Task {
            _ = await model.updateAccountSettings(
              account,
              displayName: displayName,
              avatarURL: avatarURL,
              syncHistory: syncHistory
            )
          }
        } label: {
          Label("Save", systemImage: "checkmark")
        }
        .disabled(!hasChanges || displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)

        Button {
          Task { await model.syncAccount(account, includeDiagnostics: true) }
        } label: {
          Label("Sync Recent", systemImage: "arrow.clockwise")
        }
        .disabled(model.syncingAccountID == account.id)

        if isSaving || model.syncingAccountID == account.id {
          ProgressView()
            .controlSize(.small)
        }
      }
      .buttonStyle(.bordered)
    }
    .padding(16)
    .background(.quaternary.opacity(0.24), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(Color.secondary.opacity(0.14), lineWidth: 1)
    }
    .onAppear {
      loadAccountIfNeeded()
    }
    .onChange(of: account.id) { _, _ in
      loadAccount()
    }
    .onChange(of: selectedAvatarItem) { _, item in
      Task {
        await loadAvatarImage(item)
      }
    }
  }

  private var accountImageSettings: some View {
    HStack(spacing: 12) {
      AvatarView(
        name: displayName,
        email: account.email,
        urlString: avatarPreviewURL,
        size: 40
      )

      PhotosPicker(selection: $selectedAvatarItem, matching: .images) {
        Label("Choose Image", systemImage: "photo")
      }

      Button {
        avatarURL = ""
        selectedAvatarItem = nil
      } label: {
        Label("Remove", systemImage: "xmark.circle")
      }
      .disabled(avatarURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }
  }

  private var isSaving: Bool {
    model.updatingAccountID == account.id
  }

  private var hasChanges: Bool {
    displayName.trimmingCharacters(in: .whitespacesAndNewlines) != account.displayName
      || avatarURL.trimmingCharacters(in: .whitespacesAndNewlines) != (account.avatarURL ?? "")
      || syncHistory != account.syncHistory
  }

  private var isEmbeddedAvatar: Bool {
    avatarURL.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("data:image/")
  }

  private var avatarPreviewURL: String? {
    let trimmed = avatarURL.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private var avatarURLFieldBinding: Binding<String> {
    Binding(
      get: {
        isEmbeddedAvatar ? "" : avatarURL
      },
      set: { value in
        avatarURL = value
      }
    )
  }

  private var lastSyncText: String {
    guard let lastSyncAt = account.lastSyncAt else {
      return "Never"
    }
    return MailDateFormatter.listTimestamp(lastSyncAt)
  }

  private func loadAccountIfNeeded() {
    guard loadedAccountID != account.id else { return }
    loadAccount()
  }

  private func loadAccount() {
    loadedAccountID = account.id
    displayName = account.displayName
    avatarURL = account.avatarURL ?? ""
    syncHistory = account.syncHistory
  }

  private func loadAvatarImage(_ item: PhotosPickerItem?) async {
    guard let item else { return }
    defer { selectedAvatarItem = nil }

    do {
      guard
        let data = try await item.loadTransferable(type: Data.self),
        let dataURL = AccountAvatarImageEncoder.dataURL(from: data)
      else {
        model.errorMessage = "Could not read that image."
        return
      }
      avatarURL = dataURL
      model.errorMessage = nil
    } catch {
      model.errorMessage = error.localizedDescription
    }
  }
}

private struct ServerConnectionSettingsPane: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var model = model

    SettingsPaneScroll(
      title: "Server",
      subtitle: "Connection details for the local Carta server and provider availability."
    ) {
      SettingsGroup(title: "Connection", systemImage: "network") {
        SettingsRow(title: "Server URL", detail: "The client app talks to this Carta server.") {
          TextField("URL", text: $model.serverURLString)
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.URL)
            #endif
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: 360)
        }

        SettingsDivider()

        SettingsRow(title: "Health", detail: healthDetail) {
          Button {
            Task { await model.checkHealth() }
          } label: {
            Label("Check", systemImage: "network")
          }
        }
      }

      if let profile = model.profile {
        SettingsGroup(title: "Profile", systemImage: "person.crop.circle") {
          SettingsValueRow(title: "Name", value: profile.displayName)
          SettingsDivider()
          SettingsValueRow(title: "Primary", value: profile.primaryEmail ?? "Not set")
          SettingsDivider()
          SettingsValueRow(title: "Accounts", value: "\(profile.accounts.count)")
        }
      }

      SettingsGroup(title: "Connections", systemImage: "link") {
        ProviderStatusRow(
          title: "Google",
          systemImage: "envelope.circle",
          status: model.authSettings?.gmailConfigured == true ? "Available" : "Unavailable"
        )
        .padding(.horizontal, 14)
        .padding(.vertical, 12)

        SettingsDivider()

        ProviderStatusRow(
          title: "iCloud Mail",
          systemImage: "icloud",
          status: "App password"
        )
        .padding(.horizontal, 14)
        .padding(.vertical, 12)

        if let redirectURI = model.authSettings?.gmailRedirectURI, model.authSettings?.gmailConfigured == true {
          SettingsDivider()
          SettingsValueRow(title: "Google callback", value: redirectURI)
        }
      }

      if let statusMessage = model.statusMessage {
        Text(statusMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .task {
      await model.checkHealth()
    }
  }

  private var healthDetail: String {
    guard let health = model.health else {
      return "Not checked"
    }
    return health.databasePath
  }
}

private struct SettingsValueRow: View {
  var title: String
  var value: String

  var body: some View {
    SettingsRow(title: title, detail: nil) {
      Text(value)
        .font(.callout)
        .foregroundStyle(.secondary)
        .lineLimit(2)
        .multilineTextAlignment(.trailing)
        .textSelection(.enabled)
    }
  }
}

private struct GeneralPreferencesPane: View {
  @Environment(AppModel.self) private var model
  #if os(macOS)
  var softwareUpdateController: SoftwareUpdateController?
  #endif

  var body: some View {
    @Bindable var model = model

    SettingsPaneScroll(
      title: "General",
      subtitle: "Appearance, sidebar behavior, app icon, and local interaction defaults."
    ) {
      SettingsGroup(title: "Appearance", systemImage: "paintbrush") {
        SettingsRow(title: "Theme", detail: nil) {
          Picker("Theme", selection: $model.themePreference) {
            ForEach(ThemePreference.allCases) { theme in
              Text(theme.title)
                .tag(theme)
            }
          }
          .pickerStyle(.segmented)
          .frame(maxWidth: 320)
        }
      }

      SettingsGroup(title: "Sidebar", systemImage: "sidebar.left") {
        SettingsRow(title: "Show folders", detail: "Controls whether Sent, Archive, Trash, and related folders appear globally.") {
          Toggle("Show folders", isOn: $model.showsGlobalFoldersSection)
            .labelsHidden()
        }

        SettingsDivider()

        ForEach(GlobalMailboxFolder.allCases) { folder in
          SettingsRow(title: folder.title, detail: nil) {
            Toggle(isOn: globalFolderVisibilityBinding(for: folder)) {
              Image(systemName: folder.systemImage)
            }
            .labelsHidden()
            .disabled(!model.showsGlobalFoldersSection)
          }
          if folder.id != GlobalMailboxFolder.allCases.last?.id {
            SettingsDivider()
          }
        }
      }

      #if os(iOS)
      SettingsGroup(title: "Inbox", systemImage: "tray") {
        SettingsRow(title: "Refresh button", detail: "Pull down on the inbox still refreshes mail.") {
          Toggle("Show refresh button", isOn: $model.showsIOSRefreshButton)
            .labelsHidden()
        }
      }
      #endif

      SettingsGroup(title: "App Icon", systemImage: "app") {
        AppIconSettingsSection()
          .padding(14)
      }

      #if os(macOS)
      SettingsGroup(title: "Updates", systemImage: "arrow.down.circle") {
        SettingsValueRow(title: "Version", value: appVersionText)
        SettingsDivider()
        SettingsRow(title: "Software update", detail: "Email also checks for updates automatically.") {
          Button {
            softwareUpdateController?.checkForUpdates()
          } label: {
            Label("Check", systemImage: "arrow.down.circle")
          }
          .disabled(softwareUpdateController?.canCheckForUpdates != true)
        }
      }
      #endif

      SettingsGroup(title: "Archive", systemImage: "archivebox") {
        SettingsRow(title: "Undo window", detail: "Messages archive after this delay unless you undo.") {
          Stepper(value: $model.archiveUndoDurationSeconds, in: model.archiveUndoDurationRange) {
            Text("\(model.archiveUndoDurationSeconds)s")
              .monospacedDigit()
          }
        }
      }

      if let statusMessage = model.statusMessage {
        Text(statusMessage)
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func globalFolderVisibilityBinding(for folder: GlobalMailboxFolder) -> Binding<Bool> {
    Binding(
      get: {
        model.isGlobalFolderVisible(folder)
      },
      set: { isVisible in
        model.setGlobalFolder(folder, isVisible: isVisible)
      }
    )
  }

  #if os(macOS)
  private var appVersionText: String {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Unknown"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String

    if let build, !build.isEmpty {
      return "\(version) (\(build))"
    }

    return version
  }
  #endif
}

private struct AppIconSettingsSection: View {
  @State private var selectedIcon = AppIconController.currentPreference()
  @State private var isChanging = false
  @State private var errorMessage: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), spacing: 12)], alignment: .leading, spacing: 12) {
        ForEach(AppIconPreference.allCases) { preference in
          AppIconChoiceButton(
            preference: preference,
            isSelected: selectedIcon == preference,
            isChanging: isChanging
          ) {
            select(preference)
          }
        }
      }

      if let errorMessage {
        Text(errorMessage)
          .font(.caption)
          .foregroundStyle(.red)
      }

      #if os(macOS)
      Text("The selected icon is applied to the Dock while Email is running.")
        .font(.caption)
        .foregroundStyle(.secondary)
      #endif
    }
    .padding(.vertical, 4)
    .task {
      selectedIcon = AppIconController.currentPreference()
    }
  }

  private func select(_ preference: AppIconPreference) {
    guard selectedIcon != preference, !isChanging else { return }
    isChanging = true
    errorMessage = nil

    Task {
      do {
        try await AppIconController.setIcon(preference)
        selectedIcon = preference
      } catch {
        errorMessage = error.localizedDescription
      }
      isChanging = false
    }
  }
}

private struct AppIconChoiceButton: View {
  var preference: AppIconPreference
  var isSelected: Bool
  var isChanging: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 10) {
        Image(preference.previewAssetName)
          .resizable()
          .aspectRatio(1, contentMode: .fit)
          .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
          .shadow(color: .black.opacity(0.10), radius: 8, y: 4)

        HStack(spacing: 8) {
          Text(preference.title)
            .font(.headline)
            .lineLimit(1)

          Spacer(minLength: 8)

          Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(isSelected ? .green : .secondary)
        }
      }
      .padding(10)
      .background(.quaternary.opacity(isSelected ? 0.70 : 0.35), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(isSelected ? Color.primary.opacity(0.18) : Color.secondary.opacity(0.12), lineWidth: 1)
      }
    }
    .buttonStyle(.plain)
    .disabled(isChanging)
    .accessibilityLabel(preference.accessibilityLabel)
  }
}

enum AppIconPreference: String, CaseIterable, Identifiable {
  case closed
  case open
  case closedWhite
  case openWhite

  var id: String { rawValue }

  var title: String {
    switch self {
    case .closed: "Closed Black"
    case .open: "Open Black"
    case .closedWhite: "Closed White"
    case .openWhite: "Open White"
    }
  }

  var accessibilityLabel: String {
    switch self {
    case .closed: "Closed black envelope app icon"
    case .open: "Open black envelope app icon"
    case .closedWhite: "Closed white envelope app icon"
    case .openWhite: "Open white envelope app icon"
    }
  }

  var previewAssetName: String {
    switch self {
    case .closed: "AppIconPreviewClosed"
    case .open: "AppIconPreviewOpen"
    case .closedWhite: "AppIconPreviewClosedWhite"
    case .openWhite: "AppIconPreviewOpenWhite"
    }
  }

  var alternateIconName: String? {
    switch self {
    case .closed: nil
    case .open: "AppIconOpen"
    case .closedWhite: "AppIconClosedWhite"
    case .openWhite: "AppIconOpenWhite"
    }
  }
}

@MainActor
enum AppIconController {
  static let userDefaultsKey = "email.appIconPreference"

  static func currentPreference() -> AppIconPreference {
    #if os(iOS)
    if let preference = AppIconPreference.allCases.first(where: { $0.alternateIconName == UIApplication.shared.alternateIconName }) {
      return preference
    }
    #endif

    let rawValue = UserDefaults.standard.string(forKey: userDefaultsKey)
    return rawValue.flatMap(AppIconPreference.init(rawValue:)) ?? .closed
  }

  static func applyStoredIconOnLaunch() {
    #if os(macOS)
    applyMacIcon(currentPreference())
    #endif
  }

  static func setIcon(_ preference: AppIconPreference) async throws {
    #if os(iOS)
    guard UIApplication.shared.supportsAlternateIcons else {
      throw AppIconError.unsupported
    }

    if UIApplication.shared.alternateIconName != preference.alternateIconName {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        UIApplication.shared.setAlternateIconName(preference.alternateIconName) { error in
          if let error {
            continuation.resume(throwing: error)
          } else {
            continuation.resume()
          }
        }
      }
    }
    #elseif os(macOS)
    applyMacIcon(preference)
    #endif

    UserDefaults.standard.set(preference.rawValue, forKey: userDefaultsKey)
  }

  #if os(macOS)
  private static func applyMacIcon(_ preference: AppIconPreference) {
    NSApplication.shared.applicationIconImage = NSImage(named: preference.previewAssetName)
  }
  #endif
}

private enum AppIconError: LocalizedError {
  case unsupported

  var errorDescription: String? {
    switch self {
    case .unsupported:
      "This device does not support changing the app icon."
    }
  }
}

private struct AccountsSettingsPane: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Group {
      if model.accounts.isEmpty {
        ContentUnavailableView("No Accounts", systemImage: "person.crop.square")
      } else {
        Form {
          ForEach(model.accounts) { account in
            AccountSettingsSection(account: account)
          }

          if let statusMessage = model.statusMessage {
            Section {
              Text(statusMessage)
                .font(.caption)
                .foregroundStyle(.secondary)
            }
          }
        }
        .formStyle(.grouped)
      }
    }
  }
}

private struct AccountSettingsSection: View {
  @Environment(AppModel.self) private var model
  var account: MailAccount

  @State private var displayName = ""
  @State private var avatarURL = ""
  @State private var syncHistory = true
  @State private var loadedAccountID: String?
  @State private var selectedAvatarItem: PhotosPickerItem?

  var body: some View {
    Section {
      HStack(spacing: 12) {
        AvatarView(
          name: account.displayName,
          email: account.email,
          urlString: account.avatarURL,
          size: 36
        )

        VStack(alignment: .leading, spacing: 2) {
          Text(account.displayName)
            .font(.headline)
            .lineLimit(1)
          Text(account.email)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }

        Spacer(minLength: 12)

        AccountStatusBadge(status: account.status)
      }

      accountImageSettings

      TextField("Display name", text: $displayName)
        #if os(iOS)
        .textInputAutocapitalization(.words)
        #endif

      Toggle("Download full history", isOn: $syncHistory)

      LabeledContent("Provider", value: account.provider.displayName)
      LabeledContent("Auth", value: account.authType)
      LabeledContent("Last sync", value: lastSyncText)

      AccountMailboxSummary(account: account)

      HStack {
        Button {
          Task {
            _ = await model.updateAccountSettings(
              account,
              displayName: displayName,
              avatarURL: avatarURL,
              syncHistory: syncHistory
            )
          }
        } label: {
          Label("Save", systemImage: "checkmark")
        }
        .disabled(!hasChanges || displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)

        Button {
          Task { await model.syncAccount(account, includeDiagnostics: true) }
        } label: {
          Label("Sync Now", systemImage: "arrow.clockwise")
        }
        .disabled(model.syncingAccountID == account.id)

        if isSaving || model.syncingAccountID == account.id {
          ProgressView()
            .controlSize(.small)
        }
      }
    } header: {
      Text(account.provider.displayName)
    } footer: {
      Text("The display name is used for outgoing mail from this account.")
    }
    .onAppear {
      loadAccountIfNeeded()
    }
    .onChange(of: account.id) { _, _ in
      loadAccount()
    }
    .onChange(of: selectedAvatarItem) { _, item in
      Task {
        await loadAvatarImage(item)
      }
    }
  }

  @ViewBuilder
  private var accountImageSettings: some View {
    #if os(iOS)
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 12) {
        AvatarView(
          name: displayName,
          email: account.email,
          urlString: avatarPreviewURL,
          size: 40
        )

        PhotosPicker(selection: $selectedAvatarItem, matching: .images) {
          Label("Choose", systemImage: "photo")
        }
        .buttonStyle(.borderless)

        Spacer(minLength: 8)

        Button {
          avatarURL = ""
          selectedAvatarItem = nil
        } label: {
          Image(systemName: "xmark.circle")
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .disabled(avatarURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Remove image")
      }

      TextField("Image URL", text: avatarURLFieldBinding, axis: .horizontal)
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        .autocorrectionDisabled()
        .lineLimit(1)
        .disabled(isEmbeddedAvatar)

      if isEmbeddedAvatar {
        Text("Custom image selected.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
    }
    .padding(.vertical, 2)
    #else
    LabeledContent("Image") {
      HStack(spacing: 12) {
        AvatarView(
          name: displayName,
          email: account.email,
          urlString: avatarPreviewURL,
          size: 52
        )

        VStack(alignment: .trailing, spacing: 8) {
          PhotosPicker(selection: $selectedAvatarItem, matching: .images) {
            Label("Choose Image", systemImage: "photo")
          }

          Button {
            avatarURL = ""
            selectedAvatarItem = nil
          } label: {
            Label("Remove Image", systemImage: "xmark.circle")
          }
          .disabled(avatarURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }

    TextField("Image URL", text: avatarURLFieldBinding)
      .disabled(isEmbeddedAvatar)

    if isEmbeddedAvatar {
      Text("Custom image selected.")
        .font(.caption)
        .foregroundStyle(.secondary)
    }
    #endif
  }

  private var isSaving: Bool {
    model.updatingAccountID == account.id
  }

  private var hasChanges: Bool {
    displayName.trimmingCharacters(in: .whitespacesAndNewlines) != account.displayName
      || avatarURL.trimmingCharacters(in: .whitespacesAndNewlines) != (account.avatarURL ?? "")
      || syncHistory != account.syncHistory
  }

  private var isEmbeddedAvatar: Bool {
    avatarURL.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("data:image/")
  }

  private var avatarPreviewURL: String? {
    let trimmed = avatarURL.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  private var avatarURLFieldBinding: Binding<String> {
    Binding(
      get: {
        isEmbeddedAvatar ? "" : avatarURL
      },
      set: { value in
        avatarURL = value
      }
    )
  }

  private var lastSyncText: String {
    guard let lastSyncAt = account.lastSyncAt else {
      return "Never"
    }
    return MailDateFormatter.listTimestamp(lastSyncAt)
  }

  private func loadAccountIfNeeded() {
    guard loadedAccountID != account.id else { return }
    loadAccount()
  }

  private func loadAccount() {
    loadedAccountID = account.id
    displayName = account.displayName
    avatarURL = account.avatarURL ?? ""
    syncHistory = account.syncHistory
  }

  private func loadAvatarImage(_ item: PhotosPickerItem?) async {
    guard let item else { return }
    defer { selectedAvatarItem = nil }

    do {
      guard
        let data = try await item.loadTransferable(type: Data.self),
        let dataURL = AccountAvatarImageEncoder.dataURL(from: data)
      else {
        model.errorMessage = "Could not read that image."
        return
      }
      avatarURL = dataURL
      model.errorMessage = nil
    } catch {
      model.errorMessage = error.localizedDescription
    }
  }
}

private struct AccountMailboxSummary: View {
  @Environment(AppModel.self) private var model
  var account: MailAccount

  var body: some View {
    let mailboxes = model.mailboxes.filter { $0.accountId == account.id }
    if !mailboxes.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Text("Folders")
          .font(.caption)
          .foregroundStyle(.secondary)

        LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 8)], alignment: .leading, spacing: 8) {
          ForEach(mailboxes) { mailbox in
            HStack(spacing: 6) {
              Image(systemName: folderIcon(for: mailbox.role))
                .foregroundStyle(.secondary)
              Text(mailbox.name)
                .lineLimit(1)
              let count = displayCount(for: mailbox)
              if count > 0 {
                Text("\(count)")
                  .font(.caption.monospacedDigit())
                  .foregroundStyle(.secondary)
              }
            }
            .font(.caption)
          }
        }
      }
      .padding(.vertical, 4)
    }
  }

  private func folderIcon(for role: String) -> String {
    switch role {
    case "inbox": "tray"
    case "sent": "paperplane"
    case "drafts": "doc"
    case "archive": "archivebox"
    case "spam": "exclamationmark.octagon"
    case "blocked": "hand.raised"
    case "trash": "trash"
    default: "folder"
    }
  }

  private func displayCount(for mailbox: Mailbox) -> Int {
    if mailbox.role == "inbox" {
      return mailbox.unreadCount
    }
    return mailbox.totalCount ?? mailbox.unreadCount
  }
}

private struct AccountStatusBadge: View {
  var status: String

  var body: some View {
    Text(status)
      .font(.caption)
      .foregroundStyle(status == "connected" ? .green : .secondary)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(.quaternary, in: Capsule())
  }
}

private struct ShortcutSettingsPane: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    Form {
      Section("Keyboard Shortcuts") {
        ForEach(MailShortcutAction.allCases) { action in
          ShortcutRow(action: action)
        }
      }

      Section {
        Button {
          model.resetShortcuts()
        } label: {
          Label("Restore Defaults", systemImage: "arrow.counterclockwise")
        }
      }
    }
    .formStyle(.grouped)
  }
}

private struct ShortcutRow: View {
  @Environment(AppModel.self) private var model
  var action: MailShortcutAction

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: action.systemImage)
          .foregroundStyle(.secondary)
          .frame(width: 20)

        VStack(alignment: .leading, spacing: 2) {
          Text(action.title)
            .lineLimit(1)
          Text(action.detail)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }

        Spacer(minLength: 12)

        Text(model.shortcut(for: action).displayText)
          .font(.caption.monospaced())
          .foregroundStyle(.secondary)
      }

      HStack(spacing: 10) {
        Picker("Key", selection: keyBinding) {
          ForEach(keyOptions, id: \.self) { key in
            Text(MailKeyboardShortcut.displayName(for: key))
              .tag(key)
          }
        }
        .pickerStyle(.menu)

        Picker("Modifiers", selection: modifierBinding) {
          ForEach(MailShortcutModifierPreset.allCases) { preset in
            Text(preset.title)
              .tag(preset)
          }
        }
        .pickerStyle(.menu)
      }

      if let conflict = model.shortcutConflict(for: action) {
        Text("Also assigned to \(conflict.title).")
          .font(.caption)
          .foregroundStyle(.orange)
      }
    }
    .padding(.vertical, 4)
  }

  private var keyOptions: [String] {
    let current = model.shortcut(for: action).key
    if MailKeyboardShortcut.availableKeys.contains(current) {
      return MailKeyboardShortcut.availableKeys
    }
    return [current] + MailKeyboardShortcut.availableKeys
  }

  private var keyBinding: Binding<String> {
    Binding(
      get: { model.shortcut(for: action).key },
      set: { model.updateShortcut(action, key: $0) }
    )
  }

  private var modifierBinding: Binding<MailShortcutModifierPreset> {
    Binding(
      get: { model.shortcut(for: action).modifierPreset },
      set: { model.updateShortcut(action, modifierPreset: $0) }
    )
  }
}

private enum AccountAvatarImageEncoder {
  static func dataURL(from data: Data) -> String? {
    guard
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions)
    else {
      return nil
    }

    let side = min(image.width, image.height)
    guard side > 0 else { return nil }

    let cropRect = CGRect(
      x: (CGFloat(image.width) - CGFloat(side)) / 2,
      y: (CGFloat(image.height) - CGFloat(side)) / 2,
      width: CGFloat(side),
      height: CGFloat(side)
    ).integral
    let cropped = image.cropping(to: cropRect) ?? image
    let targetSide = min(side, 512)

    guard
      let colorSpace = cropped.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
      let context = CGContext(
        data: nil,
        width: targetSide,
        height: targetSide,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      )
    else {
      return nil
    }

    context.interpolationQuality = .high
    context.draw(cropped, in: CGRect(x: 0, y: 0, width: targetSide, height: targetSide))
    guard let rendered = context.makeImage() else { return nil }

    let encoded = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
      encoded,
      UTType.jpeg.identifier as CFString,
      1,
      nil
    ) else {
      return nil
    }
    CGImageDestinationAddImage(
      destination,
      rendered,
      [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary
    )
    guard CGImageDestinationFinalize(destination) else { return nil }

    return "data:image/jpeg;base64,\((encoded as Data).base64EncodedString())"
  }

  private static var thumbnailOptions: CFDictionary {
    [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: 1024
    ] as CFDictionary
  }
}

private struct ProviderStatusRow: View {
  var title: String
  var systemImage: String
  var status: String

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: systemImage)
        .foregroundStyle(.secondary)
        .frame(width: 18)
      Text(title)
      Spacer()
      Text(status)
        .font(.caption)
        .foregroundStyle(.secondary)
    }
  }
}

private extension ByteCountFormatter {
  static func emailStorageString(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }
}
