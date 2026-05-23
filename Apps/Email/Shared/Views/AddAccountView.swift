import SwiftUI

struct AddAccountView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @Environment(AppModel.self) private var model
  @State private var provider: MailProvider = .gmail
  @State private var email = ""
  @State private var username = ""
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
            TextField("Apple ID / iCloud username", text: $username)
              #if os(iOS)
              .textInputAutocapitalization(.never)
              .keyboardType(.emailAddress)
              #endif
            SecureField("App password", text: $appPassword)
          }

          Toggle("Full history", isOn: $syncHistory)
        }

        if model.isConnectingAccount {
          Section {
            ProgressView(model.statusMessage ?? "Connecting")
          }
        }

        if let errorMessage = model.errorMessage, !errorMessage.isEmpty {
          Section {
            Label {
              Text(errorMessage)
            } icon: {
              Image(systemName: "exclamationmark.triangle")
            }
            .font(.callout)
            .foregroundStyle(.red)
          }
        }

        if provider == .gmail, model.authSettings?.gmailConfigured != true {
          Section {
            Text("Google sign-in is unavailable in this build.")
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
          Button(primaryActionTitle) {
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
                  username: username,
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
      .onAppear {
        model.errorMessage = nil
      }
      .onChange(of: provider) { _, _ in
        model.errorMessage = nil
      }
    }
    #if os(macOS)
    .frame(width: 460)
    #endif
  }

  private var isDisabled: Bool {
    if model.isConnectingAccount {
      return true
    }
    switch provider {
    case .gmail:
      return model.authSettings?.gmailConfigured != true
    case .icloud:
      return email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
        appPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }

  private var primaryActionTitle: String {
    switch provider {
    case .gmail: "Sign in with Google"
    case .icloud: "Connect iCloud Mail"
    }
  }
}
