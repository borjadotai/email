import SwiftUI

struct AddAccountView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @Environment(AppModel.self) private var model
  @State private var provider: MailProvider = .gmail
  @State private var email = ""
  @State private var displayName = ""
  @State private var appPassword = ""
  @State private var syncHistory = true

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Provider", selection: $provider) {
            ForEach(MailProvider.allCases) { provider in
              Label(provider.displayName, systemImage: provider.systemImage)
                .tag(provider)
            }
          }
          .pickerStyle(.segmented)

          TextField("Display name", text: $displayName)

          if provider == .icloud {
            TextField("Email", text: $email)
              #if os(iOS)
              .textInputAutocapitalization(.never)
              .keyboardType(.emailAddress)
              #endif
            SecureField("App password", text: $appPassword)
          }

          Toggle("Full history", isOn: $syncHistory)
        }

        if provider == .gmail, model.authSettings?.gmailClientId.isEmpty ?? true {
          Section {
            Text("Google OAuth is not configured.")
              .foregroundStyle(.secondary)
          }
        }
      }
      .formStyle(.grouped)
      .navigationTitle("Add Account")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            dismiss()
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(provider == .gmail ? "Connect" : "Add") {
            Task {
              switch provider {
              case .gmail:
                if let url = await model.startGmailAuth(displayName: displayName, syncHistory: syncHistory) {
                  openURL(url)
                  dismiss()
                }
              case .icloud:
                let connected = await model.connectICloud(
                  email: email,
                  displayName: displayName,
                  appPassword: appPassword,
                  syncHistory: syncHistory
                )
                if connected {
                  dismiss()
                }
              }
            }
          }
          .disabled(isDisabled)
        }
      }
    }
    #if os(macOS)
    .frame(width: 420)
    #endif
  }

  private var isDisabled: Bool {
    if model.isConnectingAccount {
      return true
    }
    switch provider {
    case .gmail:
      return model.authSettings?.gmailClientId.isEmpty ?? true
    case .icloud:
      return email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        appPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }
}
