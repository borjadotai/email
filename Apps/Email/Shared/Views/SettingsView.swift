import SwiftUI

struct SettingsView: View {
  @Environment(AppModel.self) private var model

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

      if !model.accounts.isEmpty {
        Section("Accounts") {
          ForEach(model.accounts) { account in
            HStack(spacing: 10) {
              Image(systemName: account.provider.systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 18)
              VStack(alignment: .leading, spacing: 2) {
                Text(account.displayName)
                  .lineLimit(1)
                Text(account.email)
                  .font(.caption)
                  .foregroundStyle(.secondary)
                  .lineLimit(1)
              }
              Spacer()
              Text(account.status)
                .font(.caption)
                .foregroundStyle(.secondary)
              Button {
                Task { await model.syncAccount(account) }
              } label: {
                Image(systemName: "arrow.clockwise")
              }
              .buttonStyle(.borderless)
              .disabled(model.syncingAccountID == account.id)
              .accessibilityLabel("Sync \(account.displayName)")
            }
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
    .navigationTitle("Settings")
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
