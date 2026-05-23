import SwiftUI

@main
struct EmailApp: App {
  @State private var model = AppModel()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .preferredColorScheme(model.colorScheme)
        #if os(macOS)
        .frame(minWidth: 1040, minHeight: 680)
        #endif
    }

    #if os(macOS)
    Settings {
      SettingsView()
        .environment(model)
        .preferredColorScheme(model.colorScheme)
        .frame(width: 460)
    }
    #endif
  }
}

