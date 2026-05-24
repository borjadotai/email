import Foundation
import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct SettingsView: View {
  @State private var selectedTab: SettingsTab = .general
  #if os(macOS)
  var softwareUpdateController: SoftwareUpdateController? = nil
  #endif

  var body: some View {
    TabView(selection: $selectedTab) {
      generalSettingsPane
        .tabItem {
          Label("General", systemImage: "gearshape")
        }
        .tag(SettingsTab.general)

      AccountsSettingsPane()
        .tabItem {
          Label("Accounts", systemImage: "person.crop.square")
        }
        .tag(SettingsTab.accounts)

      ShortcutSettingsPane()
        .tabItem {
          Label("Shortcuts", systemImage: "keyboard")
        }
        .tag(SettingsTab.shortcuts)
    }
    .navigationTitle("Settings")
  }

  private var generalSettingsPane: some View {
    #if os(macOS)
    GeneralSettingsPane(softwareUpdateController: softwareUpdateController)
    #else
    GeneralSettingsPane()
    #endif
  }
}

private enum SettingsTab: String {
  case general
  case accounts
  case shortcuts
}

private struct GeneralSettingsPane: View {
  @Environment(AppModel.self) private var model
  #if os(macOS)
  var softwareUpdateController: SoftwareUpdateController?
  #endif

  var body: some View {
    @Bindable var model = model

    Form {
      Section("Appearance") {
        Picker("Theme", selection: $model.themePreference) {
          ForEach(ThemePreference.allCases) { theme in
            Text(theme.title)
              .tag(theme)
          }
        }
        .pickerStyle(.segmented)
      }

      #if os(macOS)
      Section("Updates") {
        LabeledContent("Version", value: appVersionText)

        Button {
          softwareUpdateController?.checkForUpdates()
        } label: {
          Label("Check for Updates", systemImage: "arrow.down.circle")
        }
        .disabled(softwareUpdateController?.canCheckForUpdates != true)

        Text("Email checks for updates automatically. Use this to check now and install an available update.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }
      #endif

      Section("Archive") {
        Stepper(value: $model.archiveUndoDurationSeconds, in: model.archiveUndoDurationRange) {
          LabeledContent("Undo window") {
            Text("\(model.archiveUndoDurationSeconds)s")
              .monospacedDigit()
          }
        }

        Text("Messages are archived after this delay unless you undo.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

      Section("Server") {
        TextField("URL", text: $model.serverURLString)
          #if os(iOS)
          .textInputAutocapitalization(.never)
          .keyboardType(.URL)
          #endif

        Button {
          Task { await model.checkHealth() }
        } label: {
          Label("Check", systemImage: "network")
        }

        if let health = model.health {
          Text(health.databasePath)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
      }

      if let profile = model.profile {
        Section("Profile") {
          LabeledContent("Name", value: profile.displayName)
          if let primaryEmail = profile.primaryEmail {
            LabeledContent("Primary", value: primaryEmail)
          }
          LabeledContent("Accounts", value: "\(profile.accounts.count)")
          if model.requiresUserAuth {
            Button(role: .destructive) {
              model.signOut()
            } label: {
              Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
          }
        }
      }

      Section("Connections") {
        ProviderStatusRow(
          title: "Google",
          systemImage: "envelope.circle",
          status: model.authSettings?.gmailConfigured == true ? "Available" : "Unavailable"
        )

        ProviderStatusRow(
          title: "iCloud Mail",
          systemImage: "icloud",
          status: "App password"
        )

        if let redirectURI = model.authSettings?.gmailRedirectURI, model.authSettings?.gmailConfigured == true {
          LabeledContent("Google callback") {
            Text(redirectURI)
              .font(.caption)
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
              .lineLimit(1)
          }
        }
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
        #if os(iOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.URL)
        #endif
        .disabled(isEmbeddedAvatar)

      if isEmbeddedAvatar {
        Text("Custom image selected.")
          .font(.caption)
          .foregroundStyle(.secondary)
      }

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
          Task { await model.syncAccount(account) }
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
              if mailbox.unreadCount > 0 {
                Text("\(mailbox.unreadCount)")
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
    case "trash": "trash"
    default: "folder"
    }
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
