import SwiftUI

struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @State private var gmailClientId = ""
  @State private var gmailClientSecret = ""

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

      Section("Gmail") {
        TextField("Client ID", text: $gmailClientId)
          #if os(iOS)
          .textInputAutocapitalization(.never)
          .keyboardType(.URL)
          #endif

        SecureField(
          model.authSettings?.hasGmailClientSecret == true ? "Client secret saved" : "Client secret",
          text: $gmailClientSecret
        )
        #if os(iOS)
        .textInputAutocapitalization(.never)
        #endif

        if let redirectURI = model.authSettings?.gmailRedirectURI {
          LabeledContent("Redirect URI") {
            Text(redirectURI)
              .font(.caption)
              .foregroundStyle(.secondary)
              .textSelection(.enabled)
              .lineLimit(2)
          }
        }

        Button {
          Task {
            await model.saveAuthSettings(
              gmailClientId: gmailClientId,
              gmailClientSecret: gmailClientSecret
            )
            gmailClientSecret = ""
          }
        } label: {
          Label("Save Gmail", systemImage: "checkmark.circle")
        }
        .disabled(gmailClientId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
    .task(id: model.authSettings) {
      gmailClientId = model.authSettings?.gmailClientId ?? ""
    }
  }
}
