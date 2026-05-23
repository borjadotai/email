import SwiftUI

struct AddAccountView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var model
  @State private var provider: MailProvider = .gmail
  @State private var email = ""
  @State private var displayName = ""
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

          TextField("Email", text: $email)
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
            #endif
          TextField("Display name", text: $displayName)
          Toggle("Full history", isOn: $syncHistory)
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
          Button("Add") {
            Task {
              await model.addAccount(
                provider: provider,
                email: email,
                displayName: displayName,
                syncHistory: syncHistory
              )
              dismiss()
            }
          }
          .disabled(email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    #if os(macOS)
    .frame(width: 420)
    #endif
  }
}

