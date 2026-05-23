import SwiftUI

struct ComposeView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var model
  @State private var accountId = ""
  @State private var to = ""
  @State private var cc = ""
  @State private var bcc = ""
  @State private var subject = ""
  @State private var bodyText = ""
  @State private var trackOpens = true

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("From", selection: $accountId) {
            ForEach(model.accounts) { account in
              Text(account.email)
                .tag(account.id)
            }
          }

          TextField("To", text: $to)
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
            #endif
          TextField("Cc", text: $cc)
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
            #endif
          TextField("Bcc", text: $bcc)
            #if os(iOS)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
            #endif
          TextField("Subject", text: $subject)
        }

        Section {
          TextEditor(text: $bodyText)
            .font(.body)
            .frame(minHeight: 220)
        }

        Section {
          Toggle("Track opens", isOn: $trackOpens)
        }
      }
      .formStyle(.grouped)
      .navigationTitle("New Message")
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") {
            dismiss()
          }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Send") {
            Task {
              let sent = await model.send(SendMessageRequest(
                accountId: accountId,
                to: to,
                cc: cc,
                bcc: bcc,
                subject: subject,
                bodyText: bodyText,
                trackOpens: trackOpens
              ))
              if sent {
                dismiss()
              }
            }
          }
          .disabled(accountId.isEmpty || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
        }
      }
      .onAppear {
        if accountId.isEmpty {
          accountId = model.selectedAccountID ?? model.accounts.first?.id ?? ""
        }
      }
    }
    #if os(macOS)
    .frame(minWidth: 620, minHeight: 560)
    #endif
  }
}

