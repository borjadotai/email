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
  @FocusState private var focusedField: AddAccountFocusField?

  var body: some View {
    NavigationStack {
      accountContent
      .navigationTitle("Add Account")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(AddAccountSurface.background, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
      #endif
      .toolbar {
        addAccountToolbar
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

  @ViewBuilder
  private var accountContent: some View {
    #if os(iOS)
    iOSAccountContent
    #else
    macAccountContent
    #endif
  }

  #if os(iOS)
  private var iOSAccountContent: some View {
    ScrollView {
      VStack(spacing: 14) {
        providerCard
        detailsCard
        syncCard
        stateCards
        primaryActionButton
      }
      .padding(.horizontal, 20)
      .padding(.top, 18)
      .padding(.bottom, 28)
    }
    .background(AddAccountSurface.background.ignoresSafeArea())
    .scrollDismissesKeyboard(.interactively)
  }

  private var providerCard: some View {
    AddAccountCard {
      VStack(alignment: .leading, spacing: 12) {
        Label("Provider", systemImage: "mail.stack")
          .font(.headline)

        HStack(spacing: 10) {
          ForEach(MailProvider.allCases) { provider in
            ProviderChoiceButton(
              provider: provider,
              isSelected: self.provider == provider
            ) {
              withAnimation(.snappy(duration: 0.16)) {
                self.provider = provider
              }
            }
          }
        }
      }
    }
  }

  private var detailsCard: some View {
    AddAccountCard {
      VStack(spacing: 0) {
        fieldRow("Display name") {
          TextField("Optional", text: $displayName)
            .textContentType(.name)
            .focused($focusedField, equals: .displayName)
        }

        if provider == .icloud {
          AddAccountDivider()
          fieldRow("Email") {
            TextField("Required", text: $email)
              .textInputAutocapitalization(.never)
              .keyboardType(.emailAddress)
              .textContentType(.emailAddress)
              .autocorrectionDisabled()
              .focused($focusedField, equals: .email)
          }

          AddAccountDivider()
          fieldRow("Username") {
            TextField("Optional", text: $username)
              .textInputAutocapitalization(.never)
              .keyboardType(.emailAddress)
              .textContentType(.username)
              .autocorrectionDisabled()
              .focused($focusedField, equals: .username)
          }

          AddAccountDivider()
          fieldRow("App password") {
            SecureField("Required", text: $appPassword)
              .textContentType(.password)
              .focused($focusedField, equals: .password)
          }
        }
      }
    }
  }

  private var syncCard: some View {
    AddAccountCard {
      Toggle(isOn: $syncHistory) {
        Label("Full history", systemImage: "clock.arrow.circlepath")
          .font(.headline)
      }
    }
  }

  @ViewBuilder
  private var stateCards: some View {
    if model.isConnectingAccount {
      AddAccountStatusCard(
        title: model.statusMessage ?? "Connecting",
        systemImage: "arrow.triangle.2.circlepath",
        tint: .accentColor,
        showsProgress: true
      )
    }

    if let errorMessage = model.errorMessage, !errorMessage.isEmpty {
      AddAccountStatusCard(
        title: errorMessage,
        systemImage: "exclamationmark.triangle",
        tint: .red
      )
    }

    if provider == .gmail, model.authSettings?.gmailConfigured != true {
      AddAccountStatusCard(
        title: "Google sign-in is unavailable in this build.",
        systemImage: "exclamationmark.circle",
        tint: .secondary
      )
    }

    if provider == .gmail, let warning = model.gmailAuthConfigurationWarning {
      AddAccountStatusCard(
        title: warning,
        systemImage: "network.badge.shield.half.filled",
        tint: .orange
      )
    }
  }

  private var primaryActionButton: some View {
    Button {
      connectSelectedProvider()
    } label: {
      HStack(spacing: 10) {
        if model.isConnectingAccount {
          ProgressView()
            .controlSize(.small)
            .tint(.white)
        } else {
          Image(systemName: provider.systemImage)
        }

        Text(primaryActionTitle)
          .fontWeight(.semibold)
      }
      .frame(maxWidth: .infinity)
      .frame(height: 50)
    }
    .buttonStyle(.borderedProminent)
    .controlSize(.large)
    .disabled(isDisabled)
  }

  private func fieldRow<Content: View>(
    _ title: String,
    @ViewBuilder content: () -> Content
  ) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 12) {
      Text(title)
        .font(.subheadline)
        .foregroundStyle(.secondary)
        .frame(width: 96, alignment: .leading)

      content()
        .multilineTextAlignment(.trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .frame(minHeight: 48)
  }
  #endif

  private var macAccountContent: some View {
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
          TextField("Apple ID / iCloud username", text: $username)
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

      if provider == .gmail, let warning = model.gmailAuthConfigurationWarning {
        Section {
          Label {
            Text(warning)
          } icon: {
            Image(systemName: "network.badge.shield.half.filled")
          }
          .font(.callout)
          .foregroundStyle(.orange)
        }
      }
    }
    .formStyle(.grouped)
  }

  @ToolbarContentBuilder
  private var addAccountToolbar: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button("Cancel") {
        dismiss()
      }
    }

    #if os(macOS)
    ToolbarItem(placement: .confirmationAction) {
      Button(primaryActionTitle) {
        connectSelectedProvider()
      }
      .disabled(isDisabled)
    }
    #endif
  }

  private func connectSelectedProvider() {
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

private enum AddAccountFocusField: Hashable {
  case displayName
  case email
  case username
  case password
}

private struct ProviderChoiceButton: View {
  var provider: MailProvider
  var isSelected: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 8) {
        Image(systemName: provider.systemImage)
          .font(.title3.weight(.semibold))
          .frame(height: 24)
        Text(provider.displayName)
          .font(.subheadline.weight(.semibold))
      }
      .frame(maxWidth: .infinity)
      .frame(height: 74)
      .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(isSelected ? Color.accentColor.opacity(0.12) : AddAccountSurface.controlBackground)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(isSelected ? Color.accentColor : Color.primary.opacity(0.08), lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
  }
}

private struct AddAccountCard<Content: View>: View {
  private var content: Content

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  var body: some View {
    content
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(AddAccountSurface.cardBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }
}

private struct AddAccountDivider: View {
  var body: some View {
    Divider()
      .padding(.leading, 108)
  }
}

private struct AddAccountStatusCard: View {
  var title: String
  var systemImage: String
  var tint: Color
  var showsProgress = false

  var body: some View {
    AddAccountCard {
      HStack(alignment: .top, spacing: 10) {
        if showsProgress {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: systemImage)
            .font(.headline)
            .foregroundStyle(tint)
            .frame(width: 20)
        }

        Text(title)
          .font(.callout)
          .foregroundStyle(.primary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }
}

private enum AddAccountSurface {
  static var background: Color {
    #if os(iOS)
    Color(uiColor: .systemGroupedBackground)
    #else
    Color.clear
    #endif
  }

  static var cardBackground: Color {
    #if os(iOS)
    Color(uiColor: .secondarySystemGroupedBackground)
    #else
    Color.clear
    #endif
  }

  static var controlBackground: Color {
    #if os(iOS)
    Color(uiColor: .tertiarySystemGroupedBackground)
    #else
    Color.primary.opacity(0.05)
    #endif
  }
}
