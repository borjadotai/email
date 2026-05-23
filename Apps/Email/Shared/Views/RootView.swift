import SwiftUI

enum AppSheet: Identifiable {
  case addAccount
  case compose
  case settings

  var id: String {
    switch self {
    case .addAccount: "addAccount"
    case .compose: "compose"
    case .settings: "settings"
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model
  @State private var sheet: AppSheet?
  @State private var searchTask: Task<Void, Never>?

  var body: some View {
    @Bindable var model = model

    NavigationSplitView {
      SidebarView(onAddAccount: { sheet = .addAccount })
    } content: {
      EmailListView(
        onCompose: { sheet = .compose },
        onSettings: { sheet = .settings }
      )
      .navigationTitle(model.navigationTitle)
      .searchable(text: $model.searchText, prompt: "Search")
    } detail: {
      EmailPreviewView(onCompose: { sheet = .compose })
    }
    .task {
      await model.bootstrap()
    }
    .onSubmit(of: .search) {
      Task { await model.refreshEmails() }
    }
    .onChange(of: model.searchText) { _, _ in
      searchTask?.cancel()
      searchTask = Task {
        try? await Task.sleep(for: .milliseconds(180))
        guard !Task.isCancelled else { return }
        await model.refreshEmails()
      }
    }
    .sheet(item: $sheet) { sheet in
      switch sheet {
      case .addAccount:
        AddAccountView()
          .environment(model)
      case .compose:
        ComposeView()
          .environment(model)
      case .settings:
        SettingsView()
          .environment(model)
      }
    }
    .alert("Server unavailable", isPresented: errorBinding) {
      Button("OK") {
        model.errorMessage = nil
      }
    } message: {
      Text(model.errorMessage ?? "")
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { model.errorMessage != nil },
      set: { isPresented in
        if !isPresented {
          model.errorMessage = nil
        }
      }
    )
  }
}

