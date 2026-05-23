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
            }
          }
        }
      }
    }
    .formStyle(.grouped)
    .navigationTitle("Settings")
  }
}

