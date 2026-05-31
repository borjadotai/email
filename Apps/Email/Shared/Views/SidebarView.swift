import SwiftUI
import UniformTypeIdentifiers

struct SidebarView: View {
  @Environment(AppModel.self) private var model
  @State private var filterEditor: FilterEditorContext?
  @State private var filterPendingDeletion: MailFilter?
  @State private var draggingAccountID: String?
  @State private var draggingFilterID: String?
  @State private var accountDropTargetID: String?
  @State private var filterDropTargetID: String?
  @State private var sidebarInteractionResetToken = 0
  #if os(iOS)
  @State private var editMode: EditMode = .inactive
  #endif
  var onAddAccount: () -> Void
  var onSettings: () -> Void
  var onShowMessages: () -> Void

  var body: some View {
    ZStack {
      sidebarSurfaceBackground
        .ignoresSafeArea()

      List {
        iosSidebarTitle
        allInboxesSection
        accountsSection
        globalFoldersSection
        filtersSection
        foldersSection
        labelsSection
        settingsSection
      }
      .sidebarListStyle()
      .sidebarScrollBackground()
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .clipped()
    }
    .navigationTitle(sidebarNavigationTitle)
    .sidebarNavigationChrome()
    #if os(iOS)
    .environment(\.editMode, $editMode)
    #endif
    .toolbar {
      sidebarToolbar
    }
    #if os(iOS)
    .onChange(of: canEditSidebarItems) { _, canEdit in
      if !canEdit {
        editMode = .inactive
      }
    }
    #endif
    .confirmationDialog(
      "Delete Filter?",
      isPresented: isDeleteFilterConfirmationPresented,
      titleVisibility: .visible
    ) {
      if let filter = filterPendingDeletion {
        Button("Delete \(filter.name)", role: .destructive) {
          deleteFilter(filter)
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This only removes the saved view. It does not delete or modify any emails.")
    }
    .sheet(item: $filterEditor) { context in
      FilterEditorSheet(context: context) { draft in
        saveFilter(context: context, draft: draft)
      }
    }
  }

  private var isDeleteFilterConfirmationPresented: Binding<Bool> {
    Binding(
      get: {
        filterPendingDeletion != nil
      },
      set: { isPresented in
        if !isPresented {
          filterPendingDeletion = nil
        }
      }
    )
  }

  @ToolbarContentBuilder
  private var sidebarToolbar: some ToolbarContent {
    #if os(iOS)
    ToolbarItemGroup(placement: .topBarTrailing) {
      if canEditSidebarItems {
        Button(isEditingSidebar ? "Done" : "Edit") {
          toggleSidebarEditing()
        }
      }

      Button(action: onAddAccount) {
        Image(systemName: "plus")
      }
      .accessibilityLabel("Add account")
    }
    #else
    ToolbarItem {
      Button(action: onAddAccount) {
        Image(systemName: "plus")
      }
      .help("Add account")
    }
    #endif
  }

  private var canEditSidebarItems: Bool {
    model.accounts.count > 1 || (activeSidebarAccountID == nil && !model.filters.isEmpty)
  }

  private var isEditingSidebar: Bool {
    #if os(iOS)
    editMode.isEditing
    #else
    false
    #endif
  }

  private func toggleSidebarEditing() {
    #if os(iOS)
    withAnimation(.snappy(duration: 0.18)) {
      editMode = editMode.isEditing ? .inactive : .active
    }
    #endif
  }

  private var sidebarSurfaceBackground: Color {
    #if os(iOS)
    Color(uiColor: .systemGroupedBackground)
    #else
    Color.clear
    #endif
  }

  private var sidebarNavigationTitle: String {
    #if os(iOS)
    ""
    #else
    "Email"
    #endif
  }

  @ViewBuilder
  private var iosSidebarTitle: some View {
    #if os(iOS)
    Text("Email")
      .font(.system(size: 32, weight: .bold))
      .frame(maxWidth: .infinity, alignment: .leading)
      .listRowInsets(EdgeInsets(top: 2, leading: 20, bottom: 8, trailing: 18))
      .listRowSeparator(.hidden)
      .listRowBackground(Color.clear)
      .accessibilityAddTraits(.isHeader)
    #endif
  }

  @ViewBuilder
  private var allInboxesSection: some View {
    Section {
      SidebarButton(
        title: "All Inboxes",
        subtitle: "Global",
        systemImage: "tray.full",
        count: model.globalUnreadCount,
        isSelected: model.selectedAccountID == nil
          && model.selectedMailboxID == nil
          && model.selectedLabelID == nil
          && model.selectedFilterID == nil
          && model.selectedGlobalFolder == nil
          && !model.selectedUnreadOnly
      ) {
        selectGlobalInbox()
      }

      if model.globalUnreadCount > 0 {
        SidebarButton(
          title: "Unread",
          subtitle: "Inbox",
          systemImage: "envelope.badge",
          tint: .blue,
          count: model.globalUnreadCount,
          isSelected: model.selectedUnreadOnly
            && model.selectedAccountID == nil
            && model.selectedMailboxID == nil
            && model.selectedLabelID == nil
            && model.selectedFilterID == nil
            && model.selectedGlobalFolder == nil
        ) {
          selectUnreadInbox()
        }
      }
    }
  }

  @ViewBuilder
  private var accountsSection: some View {
    if !model.accounts.isEmpty {
      Section("Accounts") {
        ForEach(model.accounts) { account in
          accountSidebarRow(account)
        }
        .onMove(perform: moveAccounts)
      }
    }
  }

  @ViewBuilder
  private func accountSidebarRow(_ account: MailAccount) -> some View {
    let row = SidebarButton(
      title: account.displayName,
      subtitle: account.email,
      systemImage: account.provider.systemImage,
      avatarName: account.displayName,
      avatarEmail: account.email,
      avatarURL: account.avatarURL,
      count: unreadCount(for: account),
      isSelected: model.selectedAccountID == account.id
        && model.selectedMailboxID == nil
        && model.selectedLabelID == nil
        && model.selectedFilterID == nil
        && model.selectedGlobalFolder == nil
        && !model.selectedUnreadOnly,
      isReorderable: model.accounts.count > 1,
      isEditing: isEditingSidebar,
      isDragging: draggingAccountID == account.id,
      showsInsertionLine: accountDropTargetID == account.id,
      resetToken: sidebarInteractionResetToken
    ) {
      selectAccount(account)
    }

    #if os(macOS)
    row
      .onDrag {
        withAnimation(.snappy(duration: 0.16)) {
          draggingAccountID = account.id
        }
        return NSItemProvider(object: account.id as NSString)
      } preview: {
        SidebarDragPreview(
          title: account.displayName,
          subtitle: account.email,
          systemImage: account.provider.systemImage,
          avatarName: account.displayName,
          avatarEmail: account.email,
          avatarURL: account.avatarURL,
          count: unreadCount(for: account)
        )
      }
      .onDrop(
        of: [.text],
        delegate: SidebarReorderDropDelegate(
          targetID: account.id,
          draggingID: $draggingAccountID,
          dropTargetID: $accountDropTargetID,
          move: { sourceID, targetID in
            model.moveAccount(id: sourceID, before: targetID)
          },
          persist: {
            model.persistAccountOrder()
          },
          cleanup: {
            clearSidebarDragState()
          }
        )
      )
    #else
    row
    #endif
  }

  @ViewBuilder
  private var globalFoldersSection: some View {
    let folders = model.enabledGlobalFolders
    if activeSidebarAccountID == nil && !folders.isEmpty {
      Section("Folders") {
        ForEach(folders) { folder in
          SidebarButton(
            title: folder.title,
            subtitle: nil,
            systemImage: folder.systemImage,
            tint: tint(for: folder),
            count: totalCount(for: folder),
            isSelected: model.selectedGlobalFolder == folder
          ) {
            selectGlobalFolder(folder)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var filtersSection: some View {
    if activeSidebarAccountID == nil {
      Section("Filters") {
        ForEach(model.filters) { filter in
          filterSidebarRow(filter)
        }
        .onMove(perform: moveFilters)

        SidebarButton(
          title: "New Filter",
          subtitle: nil,
          systemImage: "plus.circle",
          tint: .secondary,
          isSelected: false
        ) {
          filterEditor = .create
        }
      }
    }
  }

  @ViewBuilder
  private func filterSidebarRow(_ filter: MailFilter) -> some View {
    let row = FilterSidebarRow(
      filter: filter,
      count: filter.emailCount ?? 0,
      isSelected: model.selectedFilterID == filter.id && model.selectedGlobalFolder == nil,
      isReorderable: model.filters.count > 1,
      isEditing: isEditingSidebar,
      isDragging: draggingFilterID == filter.id,
      showsInsertionLine: filterDropTargetID == filter.id,
      resetToken: sidebarInteractionResetToken,
      onSelect: {
        selectFilter(filter)
      },
      onEdit: {
        filterEditor = .edit(filter)
      },
      onDelete: {
        filterPendingDeletion = filter
      }
    )
    .contextMenu {
      Button("Edit Filter") {
        filterEditor = .edit(filter)
      }
      Button("Delete Filter", role: .destructive) {
        filterPendingDeletion = filter
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      Button(role: .destructive) {
        filterPendingDeletion = filter
      } label: {
        Label("Delete", systemImage: "trash")
      }
    }
    .accessibilityAction(named: "Delete Filter") {
      filterPendingDeletion = filter
    }

    #if os(macOS)
    row
      .onDrag {
        withAnimation(.snappy(duration: 0.16)) {
          draggingFilterID = filter.id
        }
        return NSItemProvider(object: filter.id as NSString)
      } preview: {
        SidebarDragPreview(
          title: filter.name,
          subtitle: nil,
          systemImage: filter.systemImage,
          tint: filter.swiftUIColor,
          count: filter.emailCount ?? 0
        )
      }
      .onDrop(
        of: [.text],
        delegate: SidebarReorderDropDelegate(
          targetID: filter.id,
          draggingID: $draggingFilterID,
          dropTargetID: $filterDropTargetID,
          move: { sourceID, targetID in
            model.moveFilter(id: sourceID, before: targetID)
          },
          persist: {
            model.persistFilterOrder()
          },
          cleanup: {
            clearSidebarDragState()
          }
        )
      )
    #else
    row
    #endif
  }

  @ViewBuilder
  private var foldersSection: some View {
    let visibleMailboxes = scopedMailboxes
    if !visibleMailboxes.isEmpty {
      Section("Account Folders") {
        if let activeSidebarAccountID,
           accountUnreadCount(for: activeSidebarAccountID) > 0 {
          SidebarButton(
            title: "Unread",
            subtitle: nil,
            systemImage: "envelope.badge",
            tint: .blue,
            count: accountUnreadCount(for: activeSidebarAccountID),
            isSelected: model.selectedUnreadOnly
              && model.selectedAccountID == activeSidebarAccountID
              && model.selectedMailboxID == nil
              && model.selectedLabelID == nil
              && model.selectedFilterID == nil
              && model.selectedGlobalFolder == nil
          ) {
            selectUnreadInbox(accountID: activeSidebarAccountID)
          }
        }

        ForEach(visibleMailboxes) { mailbox in
          SidebarButton(
            title: mailbox.name,
            subtitle: nil,
            systemImage: image(for: mailbox.role),
            count: displayCount(for: mailbox),
            isSelected: model.selectedMailboxID == mailbox.id
              && model.selectedGlobalFolder == nil
              && !model.selectedUnreadOnly
          ) {
            selectMailbox(mailbox)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var labelsSection: some View {
    let visibleLabels = scopedLabels
    if !visibleLabels.isEmpty {
      Section("Labels") {
        ForEach(visibleLabels) { label in
          SidebarButton(
            title: label.name,
            subtitle: nil,
            systemImage: "tag",
            tint: label.swiftUIColor,
            isSelected: model.selectedLabelID == label.id && model.selectedGlobalFolder == nil
          ) {
            selectLabel(label)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var settingsSection: some View {
    Section {
      SidebarButton(
        title: "Settings",
        subtitle: nil,
        systemImage: "gearshape",
        tint: .secondary,
        isSelected: false
      ) {
        onSettings()
      }
    }
  }

  private func selectGlobalInbox() {
    onShowMessages()
    Task {
      await model.selectGlobalInbox()
    }
  }

  private func selectUnreadInbox(accountID: String? = nil) {
    onShowMessages()
    Task {
      await model.selectUnreadInbox(accountID: accountID)
    }
  }

  private func selectAccount(_ account: MailAccount) {
    onShowMessages()
    Task {
      await model.selectAccount(account)
    }
  }

  private func selectGlobalFolder(_ folder: GlobalMailboxFolder) {
    onShowMessages()
    Task {
      await model.selectGlobalFolder(folder)
    }
  }

  private func selectFilter(_ filter: MailFilter) {
    onShowMessages()
    Task {
      await model.selectFilter(filter)
    }
  }

  private func selectMailbox(_ mailbox: Mailbox) {
    onShowMessages()
    Task {
      await model.selectMailbox(mailbox)
    }
  }

  private func selectLabel(_ label: MailLabel) {
    onShowMessages()
    Task {
      await model.selectLabel(label)
    }
  }

  private func saveFilter(context: FilterEditorContext, draft: FilterEditorDraft) {
    Task {
      if let filter = context.filter {
        await model.updateFilter(
          filter,
          naturalLanguage: draft.naturalLanguage
        )
      } else {
        await model.createFilter(naturalLanguage: draft.naturalLanguage)
      }
    }
  }

  private func deleteFilter(_ filter: MailFilter) {
    Task {
      await model.deleteFilter(filter)
    }
  }

  private func moveAccounts(from source: IndexSet, to destination: Int) {
    model.moveAccounts(from: source, to: destination)
  }

  private func moveFilters(from source: IndexSet, to destination: Int) {
    model.moveFilters(from: source, to: destination)
  }

  private func clearSidebarDragState() {
    withAnimation(.snappy(duration: 0.16)) {
      draggingAccountID = nil
      draggingFilterID = nil
      accountDropTargetID = nil
      filterDropTargetID = nil
      sidebarInteractionResetToken += 1
    }
  }

  private func unreadCount(for account: MailAccount) -> Int {
    accountUnreadCount(for: account.id)
  }

  private func accountUnreadCount(for accountID: String) -> Int {
    model.mailboxes
      .filter { $0.accountId == accountID && $0.role == "inbox" }
      .reduce(0) { $0 + $1.unreadCount }
  }

  private func totalCount(for folder: GlobalMailboxFolder) -> Int {
    model.mailboxes
      .filter { $0.role == folder.rawValue }
      .reduce(0) { $0 + displayCount(for: $1) }
  }

  private func displayCount(for mailbox: Mailbox) -> Int {
    if mailbox.role == "inbox" {
      return mailbox.unreadCount
    }
    return mailbox.totalCount ?? mailbox.unreadCount
  }

  private var activeSidebarAccountID: String? {
    if let selectedAccountID = model.selectedAccountID {
      return selectedAccountID
    }

    if let selectedMailboxID = model.selectedMailboxID {
      return model.mailboxes.first(where: { $0.id == selectedMailboxID })?.accountId
    }

    if let selectedLabelID = model.selectedLabelID {
      return model.labels.first(where: { $0.id == selectedLabelID })?.accountId
    }

    return nil
  }

  private var scopedMailboxes: [Mailbox] {
    guard let accountID = activeSidebarAccountID else { return [] }
    return model.mailboxes.filter { $0.accountId == accountID }
  }

  private var scopedLabels: [MailLabel] {
    if let accountID = activeSidebarAccountID {
      return model.labels.filter { $0.accountId == accountID }
    }

    return []
  }

  private func image(for role: String) -> String {
    switch role {
    case "inbox": "tray"
    case "sent": "paperplane"
    case "drafts": "doc"
    case "archive": "archivebox"
    case "spam": "exclamationmark.octagon"
    case "blocked": "hand.raised"
    case "trash": "trash"
    default: "folder"
    }
  }

  private func tint(for folder: GlobalMailboxFolder) -> Color {
    switch folder {
    case .sent: .blue
    case .drafts: .teal
    case .archive: .secondary
    case .spam: .orange
    case .blocked: .pink
    case .trash: .red
    }
  }
}

private struct FilterEditorContext: Identifiable {
  var id: String
  var filter: MailFilter?

  static var create: FilterEditorContext {
    FilterEditorContext(id: "create-\(UUID().uuidString)", filter: nil)
  }

  static func edit(_ filter: MailFilter) -> FilterEditorContext {
    FilterEditorContext(id: "edit-\(filter.id)", filter: filter)
  }
}

private struct FilterEditorDraft {
  var naturalLanguage: String
}

private struct FilterEditorSheet: View {
  @Environment(\.dismiss) private var dismiss
  var context: FilterEditorContext
  var onSave: (FilterEditorDraft) -> Void

  @State private var naturalLanguage: String
  @FocusState private var promptFocused: Bool

  init(context: FilterEditorContext, onSave: @escaping (FilterEditorDraft) -> Void) {
    self.context = context
    self.onSave = onSave
    let filter = context.filter
    _naturalLanguage = State(initialValue: filter?.naturalLanguage ?? "")
  }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          naturalLanguageBuilder
        }
        .padding(20)
      }
      Divider()
      footer
    }
    #if os(macOS)
    .frame(width: 640, height: 430)
    #endif
    #if os(iOS)
    .presentationDetents([.large])
    #endif
    .task {
      promptFocused = true
    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      Text(context.filter == nil ? "New Filter" : "Edit Filter")
        .font(.title2.weight(.semibold))

      Spacer()

      Button {
        dismiss()
      } label: {
        Image(systemName: "xmark")
      }
      .buttonStyle(.borderless)
      .help("Close")
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
  }

  private var naturalLanguageBuilder: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 3) {
        Text("Describe the view")
          .font(.headline)
        Text("Examples: all my invoices, newsletters, unread emails from Stripe, receipts from any account.")
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }

      ZStack(alignment: .topLeading) {
        TextEditor(text: $naturalLanguage)
          .focused($promptFocused)
          .font(.body)
          .scrollContentBackground(.hidden)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .frame(minHeight: 220)

        if naturalLanguage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          Text("All my invoices")
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 18)
            .padding(.vertical, 18)
            .allowsHitTesting(false)
        }

        VStack {
          HStack {
            Spacer()
            Button {
              promptFocused = true
            } label: {
              Image(systemName: "mic")
            }
            .buttonStyle(.borderless)
            .padding(12)
            .help("Dictate")
          }
          Spacer()
        }
      }
      .background(sheetCardBackground)
      .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .strokeBorder(Color.primary.opacity(0.10))
      )
    }
  }

  private var footer: some View {
    HStack {
      Spacer()
      Button("Cancel") {
        dismiss()
      }
      Button("Save") {
        onSave(draft)
        dismiss()
      }
      .keyboardShortcut(.defaultAction)
      .disabled(!canSave)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 14)
  }

  private var draft: FilterEditorDraft {
    FilterEditorDraft(
      naturalLanguage: trimmedNaturalLanguage
    )
  }

  private var canSave: Bool {
    !trimmedNaturalLanguage.isEmpty
  }

  private var trimmedNaturalLanguage: String {
    naturalLanguage.trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

private var sheetCardBackground: Color {
  #if os(macOS)
  Color(nsColor: .controlBackgroundColor)
  #else
  Color(uiColor: .secondarySystemGroupedBackground)
  #endif
}

private extension View {
  @ViewBuilder
  func sidebarScrollBackground() -> some View {
    #if os(iOS)
    self
      .scrollContentBackground(.hidden)
      .background(Color(uiColor: .systemGroupedBackground))
    #else
    self
    #endif
  }

  @ViewBuilder
  func sidebarNavigationChrome() -> some View {
    #if os(iOS)
    self
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Color(uiColor: .systemGroupedBackground), for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
    #else
    self
    #endif
  }

  @ViewBuilder
  func sidebarListStyle() -> some View {
    #if os(iOS)
    self
      .listStyle(.plain)
    #else
    self
      .listStyle(.sidebar)
    #endif
  }

  @ViewBuilder
  func sidebarListRowChrome() -> some View {
    #if os(iOS)
    self
      .listRowInsets(EdgeInsets(top: 6, leading: 18, bottom: 6, trailing: 18))
      .listRowSeparator(.hidden)
    #else
    self
    #endif
  }
}

private struct SidebarReorderDropDelegate: DropDelegate {
  var targetID: String
  @Binding var draggingID: String?
  @Binding var dropTargetID: String?
  var move: (String, String) -> Void
  var persist: () -> Void
  var cleanup: () -> Void

  func dropEntered(info: DropInfo) {
    guard let draggingID, draggingID != targetID else { return }
    withAnimation(.snappy(duration: 0.18)) {
      dropTargetID = targetID
      move(draggingID, targetID)
    }
  }

  func dropUpdated(info: DropInfo) -> DropProposal? {
    if let draggingID, draggingID != targetID, dropTargetID != targetID {
      withAnimation(.snappy(duration: 0.12)) {
        dropTargetID = targetID
      }
    }
    return DropProposal(operation: .move)
  }

  func performDrop(info: DropInfo) -> Bool {
    persist()
    cleanup()
    return true
  }

  func dropExited(info: DropInfo) {
    guard dropTargetID == targetID else { return }
    withAnimation(.snappy(duration: 0.12)) {
      dropTargetID = nil
    }
  }
}

private struct FilterSidebarRow: View {
  var filter: MailFilter
  var count: Int
  var isSelected: Bool
  var isReorderable: Bool
  var isEditing = false
  var isDragging = false
  var showsInsertionLine = false
  var resetToken = 0
  var onSelect: () -> Void
  var onEdit: () -> Void
  var onDelete: () -> Void

  @State private var isHovered = false

  var body: some View {
    HStack(spacing: 8) {
      Button(action: onSelect) {
        SidebarRowContent(
          title: filter.name,
          subtitle: nil,
          systemImage: filter.systemImage,
          avatarName: nil,
          avatarEmail: nil,
          avatarURL: nil,
          tint: filter.swiftUIColor,
          count: count,
          showsDragHandle: false
        )
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .frame(maxWidth: .infinity, alignment: .leading)

      if showsInlineActions {
        if isReorderable {
          SidebarDragHandle()
            .transition(.opacity.combined(with: .scale(scale: 0.84)))
        }

        Button(action: onEdit) {
          Image(systemName: "pencil")
            .font(.caption.weight(.semibold))
            .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("Edit filter")

        Button(role: .destructive, action: onDelete) {
          Image(systemName: "trash")
            .font(.caption.weight(.semibold))
            .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .help("Delete filter")
      }
    }
    .contentShape(Rectangle())
    .onHover { hovering in
      withAnimation(.snappy(duration: 0.14)) {
        isHovered = hovering
      }
    }
    .onChange(of: resetToken) { _, _ in
      isHovered = false
    }
    .scaleEffect(isDragging ? 0.985 : 1)
    .opacity(isDragging ? 0.82 : 1)
    .animation(.snappy(duration: 0.18), value: isDragging)
    .animation(.snappy(duration: 0.18), value: showsInsertionLine)
    .animation(.snappy(duration: 0.18), value: showsInlineActions)
    .overlay(alignment: .top) {
      if showsInsertionLine && !isDragging {
        SidebarInsertionLine()
      }
    }
    .listRowBackground(
      SidebarRowBackground(
        isSelected: isSelected,
        isHovered: isHovered
      )
    )
    .sidebarListRowChrome()
  }

  private var showsInlineActions: Bool {
    #if os(iOS)
    isEditing
    #else
    isEditing || isHovered || isSelected
    #endif
  }
}

private struct SidebarButton: View {
  var title: String
  var subtitle: String?
  var systemImage: String
  var avatarName: String? = nil
  var avatarEmail: String? = nil
  var avatarURL: String? = nil
  var tint: Color = .secondary
  var count: Int = 0
  var isSelected: Bool
  var isReorderable = false
  var isEditing = false
  var isDragging = false
  var showsInsertionLine = false
  var resetToken = 0
  var action: () -> Void

  @State private var isHovered = false

  var body: some View {
    Button(action: action) {
      SidebarRowContent(
        title: title,
        subtitle: subtitle,
        systemImage: systemImage,
        avatarName: avatarName,
        avatarEmail: avatarEmail,
        avatarURL: avatarURL,
        tint: tint,
        count: count,
        showsDragHandle: isReorderable && (isEditing || isHovered)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hovering in
      withAnimation(.snappy(duration: 0.14)) {
        isHovered = hovering
      }
    }
    .onChange(of: resetToken) { _, _ in
      isHovered = false
    }
    .scaleEffect(isDragging ? 0.985 : 1)
    .opacity(isDragging ? 0.82 : 1)
    .animation(.snappy(duration: 0.18), value: isDragging)
    .animation(.snappy(duration: 0.18), value: showsInsertionLine)
    .overlay(alignment: .top) {
      if showsInsertionLine && !isDragging {
        SidebarInsertionLine()
      }
    }
    .listRowBackground(
      SidebarRowBackground(
        isSelected: isSelected,
        isHovered: isHovered
      )
    )
    .sidebarListRowChrome()
  }
}

private struct SidebarDragPreview: View {
  var title: String
  var subtitle: String?
  var systemImage: String
  var avatarName: String? = nil
  var avatarEmail: String? = nil
  var avatarURL: String? = nil
  var tint: Color = .secondary
  var count: Int = 0

  var body: some View {
    SidebarRowContent(
      title: title,
      subtitle: subtitle,
      systemImage: systemImage,
      avatarName: avatarName,
      avatarEmail: avatarEmail,
      avatarURL: avatarURL,
      tint: tint,
      count: count,
      showsDragHandle: true
    )
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .frame(width: 236, alignment: .leading)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .strokeBorder(Color.primary.opacity(0.10))
    )
    .shadow(color: .black.opacity(0.18), radius: 14, x: 0, y: 8)
  }
}

private struct SidebarRowContent: View {
  var title: String
  var subtitle: String?
  var systemImage: String
  var avatarName: String?
  var avatarEmail: String?
  var avatarURL: String?
  var tint: Color
  var count: Int
  var showsDragHandle: Bool

  var body: some View {
    HStack(spacing: rowSpacing) {
      if let avatarName, let avatarEmail {
        AvatarView(
          name: avatarName,
          email: avatarEmail,
          urlString: avatarURL,
          size: avatarSize
        )
        .frame(width: iconWidth)
      } else {
        Image(systemName: systemImage)
          .font(iconFont)
          .foregroundStyle(tint)
          .frame(width: iconWidth)
      }

      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(titleFont)
          .lineLimit(1)
        if let subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(subtitleFont)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }

      Spacer(minLength: 6)

      if count > 0 {
        Text(count, format: .number)
          .font(countFont)
          .foregroundStyle(.secondary)
          .monospacedDigit()
      }

      if showsDragHandle {
        SidebarDragHandle()
          .transition(.opacity.combined(with: .scale(scale: 0.84)))
      }
    }
    .frame(minHeight: rowMinHeight, alignment: .center)
  }

  private var avatarSize: CGFloat {
    #if os(iOS)
    30
    #else
    24
    #endif
  }

  private var iconWidth: CGFloat {
    #if os(iOS)
    30
    #else
    24
    #endif
  }

  private var rowSpacing: CGFloat {
    #if os(iOS)
    12
    #else
    10
    #endif
  }

  private var titleFont: Font {
    #if os(iOS)
    .system(size: 18, weight: .regular)
    #else
    .body
    #endif
  }

  private var subtitleFont: Font {
    #if os(iOS)
    .system(size: 14)
    #else
    .caption
    #endif
  }

  private var countFont: Font {
    #if os(iOS)
    .subheadline.weight(.semibold)
    #else
    .caption2.weight(.semibold)
    #endif
  }

  private var iconFont: Font {
    #if os(iOS)
    .system(size: 22, weight: .regular)
    #else
    .body
    #endif
  }

  private var rowMinHeight: CGFloat {
    #if os(iOS)
    46
    #else
    0
    #endif
  }
}

private struct SidebarDragHandle: View {
  var body: some View {
    Image(systemName: "line.3.horizontal")
      .font(.caption.weight(.semibold))
      .foregroundStyle(.tertiary)
      .frame(width: 16, height: 18)
      .help("Drag to reorder")
  }
}

private struct SidebarRowBackground: View {
  var isSelected: Bool
  var isHovered: Bool

  var body: some View {
    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
      .fill(fill)
      .padding(.horizontal, horizontalPadding)
      .padding(.vertical, 1)
  }

  private var horizontalPadding: CGFloat {
    #if os(iOS)
    8
    #else
    0
    #endif
  }

  private var cornerRadius: CGFloat {
    #if os(iOS)
    14
    #else
    7
    #endif
  }

  private var fill: Color {
    if isSelected {
      return Color.mailSelectionBackground
    }
    if isHovered {
      return Color.primary.opacity(0.06)
    }
    return .clear
  }
}

private struct SidebarInsertionLine: View {
  var body: some View {
    Capsule()
      .fill(Color.accentColor)
      .frame(height: 2)
      .padding(.horizontal, 8)
      .shadow(color: Color.accentColor.opacity(0.28), radius: 4, x: 0, y: 0)
      .allowsHitTesting(false)
      .transition(.opacity)
  }
}
