import SwiftUI

@main
struct EmailApp: App {
  @State private var model = AppModel()
  #if os(macOS)
  @State private var localServer = LocalServerController()
  #endif

  var body: some Scene {
    WindowGroup {
      RootView(prepareForBootstrap: prepareForBootstrap)
        .environment(model)
        .preferredColorScheme(model.colorScheme)
        #if os(macOS)
        .frame(minWidth: 1040, minHeight: 680)
        #endif
    }
    #if os(macOS)
    .commands {
      MailCommands(model: model)
    }
    #endif

    #if os(macOS)
    Settings {
      SettingsView()
        .environment(model)
        .preferredColorScheme(model.colorScheme)
        .frame(width: 580, height: 560)
    }
    #endif
  }

  private func prepareForBootstrap() async {
    #if os(macOS)
    await localServer.startIfAvailable()
    #endif
  }
}

#if os(macOS)
struct MailCommands: Commands {
  var model: AppModel

  var body: some Commands {
    CommandMenu("Message") {
      commandButton(.compose)

      Divider()

      commandButton(.archive)
      commandButton(.toggleRead)
      commandButton(.toggleStar)
      commandButton(.markSpam)
    }

    CommandMenu("Mailbox") {
      commandButton(.refresh)
      commandButton(.search)
    }
  }

  private func commandButton(_ action: MailShortcutAction) -> some View {
    Button(action.title) {
      Task { await model.performShortcutAction(action) }
    }
    .mailKeyboardShortcut(model.shortcut(for: action))
    .disabled(isDisabled(action))
  }

  private func isDisabled(_ action: MailShortcutAction) -> Bool {
    switch action {
    case .compose, .refresh, .search:
      false
    case .archive:
      model.selectedEmailID == nil || model.isArchiving
    case .toggleRead, .toggleStar, .markSpam:
      model.selectedEmailID == nil
    }
  }
}
#endif
