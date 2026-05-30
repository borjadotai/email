import SwiftUI
import WebKit

#if os(iOS)
import UIKit
#endif

struct ComposeView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(AppModel.self) private var model
  @State private var accountId = ""
  @State private var to = ""
  @State private var cc = ""
  @State private var bcc = ""
  @State private var subject = ""
  @State private var bodyText = ""
  @State private var bodyHTML = ""
  @State private var rawHTML = ""
  @State private var trackOpens = true
  @State private var showCarbonCopyFields = false
  @State private var isShowingCarbonCopyHover = false
  @State private var editorMode: ComposerEditorMode = .write

  var body: some View {
    #if os(macOS)
    macOSBody
    #else
    iOSBody
    #endif
  }

  #if os(iOS)
  private var iOSBody: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 16) {
          iOSAddressCard
          iOSEditorCard
          iOSTrackingCard
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 18)
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .scrollDismissesKeyboard(.interactively)
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
              await sendAndDismiss()
            }
          }
          .disabled(accountId.isEmpty || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
        }
      }
      .onAppear(perform: loadInitialState)
    }
  }

  private var iOSAddressCard: some View {
    VStack(spacing: 0) {
      LabeledContent("From") {
        Picker("From", selection: $accountId) {
          ForEach(model.accounts) { account in
            Text(account.email)
              .tag(account.id)
          }
        }
        .labelsHidden()
      }
      .padding(.vertical, 12)

      Divider()

      recipientFields
        .padding(.vertical, 12)

      Divider()

      TextField("Subject", text: $subject)
        .padding(.vertical, 12)
    }
    .padding(.horizontal, 14)
    .background(ComposerSurface.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var iOSEditorCard: some View {
    ComposerEditor(
      mode: $editorMode,
      bodyHTML: $bodyHTML,
      bodyText: $bodyText,
      rawHTML: $rawHTML
    )
    .frame(height: 390)
    .background(ComposerSurface.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var iOSTrackingCard: some View {
    Toggle("Track opens", isOn: $trackOpens)
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .background(ComposerSurface.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
  #endif

  #if os(macOS)
  private var macOSBody: some View {
    VStack(spacing: 0) {
      HStack {
        Text("New Message")
          .font(.title2.weight(.semibold))
        Spacer()
      }
      .padding(.horizontal, 40)
      .padding(.top, 28)
      .padding(.bottom, 24)

      Divider()

      ScrollView {
        VStack(spacing: 20) {
          macOSAddressCard

          ComposerEditor(
            mode: $editorMode,
            bodyHTML: $bodyHTML,
            bodyText: $bodyText,
            rawHTML: $rawHTML
          )
          .frame(minHeight: 340)
          .padding(20)
          .background(ComposerSurface.cardBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .stroke(ComposerSurface.borderColor, lineWidth: 0.5)
          }

          HStack {
            Text("Track opens")
              .font(.headline)
            Spacer()
            Toggle("Track opens", isOn: $trackOpens)
              .labelsHidden()
          }
          .padding(.horizontal, 20)
          .padding(.vertical, 14)
          .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .padding(.horizontal, 40)
        .padding(.vertical, 28)
      }

      Divider()

      HStack(spacing: 12) {
        Spacer()
        Button("Cancel") {
          dismiss()
        }
        .keyboardShortcut(.cancelAction)

        Button("Send") {
          Task {
            await sendAndDismiss()
          }
        }
        .keyboardShortcut(.defaultAction)
        .disabled(accountId.isEmpty || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
      }
      .padding(.horizontal, 40)
      .padding(.vertical, 18)
    }
    .frame(minWidth: 760, minHeight: 690)
    .onAppear(perform: loadInitialState)
  }

  private var macOSAddressCard: some View {
    VStack(spacing: 0) {
      macOSAccountRow
      Divider()
      macOSRecipientRow

      if showCarbonCopyFields || !cc.isEmpty || !bcc.isEmpty {
        Divider()
        macOSFieldRow(label: "Cc") {
          RecipientSuggestionField("", text: $cc)
        }
        Divider()
        macOSFieldRow(label: "Bcc") {
          RecipientSuggestionField("", text: $bcc)
        }
      }

      Divider()
      macOSFieldRow(label: "Subject") {
        TextField("", text: $subject)
          .textFieldStyle(.plain)
      }
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 8)
    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
  }

  private var macOSAccountRow: some View {
    macOSFieldRow(label: "From") {
      Picker("", selection: $accountId) {
        ForEach(model.accounts) { account in
          Text(account.email)
            .tag(account.id)
        }
      }
      .labelsHidden()
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
  }

  private var macOSRecipientRow: some View {
    HStack(spacing: 8) {
      Text("To")
        .font(.headline)
        .foregroundStyle(.secondary)
        .frame(width: 64, alignment: .leading)

      if shouldShowCarbonCopyToggle {
        Button {
          withAnimation(.snappy(duration: 0.18)) {
            showCarbonCopyFields.toggle()
          }
        } label: {
          Text("Cc/Bcc")
            .font(.caption.weight(.medium))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .accessibilityLabel(showCarbonCopyFields ? "Hide Cc and Bcc" : "Show Cc and Bcc")
        .transition(.opacity.combined(with: .move(edge: .leading)))
      }

      RecipientSuggestionField("", text: $to)
        .frame(maxWidth: .infinity)
    }
    .padding(.vertical, 13)
    .onHover { isHovering in
      withAnimation(.snappy(duration: 0.16)) {
        isShowingCarbonCopyHover = isHovering
      }
    }
  }

  private func macOSFieldRow<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
    HStack(spacing: 12) {
      Text(label)
        .font(.headline)
        .foregroundStyle(.secondary)
        .frame(width: 64, alignment: .leading)

      content()
        .font(.headline)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.vertical, 13)
  }
  #endif

  private var recipientFields: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        if shouldShowCarbonCopyToggle {
          Button {
            withAnimation(.snappy(duration: 0.18)) {
              showCarbonCopyFields.toggle()
            }
          } label: {
            Text("Cc/Bcc")
              .font(.caption.weight(.medium))
          }
          .buttonStyle(.borderless)
          .foregroundStyle(.secondary)
          .accessibilityLabel(showCarbonCopyFields ? "Hide Cc and Bcc" : "Show Cc and Bcc")
        }

        RecipientSuggestionField("To", text: $to)
      }
      #if os(macOS)
      .onHover { isHovering in
        withAnimation(.snappy(duration: 0.16)) {
          isShowingCarbonCopyHover = isHovering
        }
      }
      #endif

      if showCarbonCopyFields || !cc.isEmpty || !bcc.isEmpty {
        RecipientSuggestionField("Cc", text: $cc)

        RecipientSuggestionField("Bcc", text: $bcc)
      }
    }
  }

  private var shouldShowCarbonCopyToggle: Bool {
    #if os(macOS)
    isShowingCarbonCopyHover || showCarbonCopyFields || !cc.isEmpty || !bcc.isEmpty
    #else
    true
    #endif
  }

  private var outgoingBodyHTML: String? {
    switch editorMode {
    case .write:
      return bodyHTML.trimmedNonEmpty
    case .html:
      return rawHTML.trimmedNonEmpty
    }
  }

  private var outgoingBodyText: String {
    switch editorMode {
    case .write:
      return bodyText.trimmedNonEmpty ?? bodyHTML.htmlPlainText
    case .html:
      return rawHTML.htmlPlainText
    }
  }

  private func loadInitialState() {
    if let draft = model.composeDraft {
      accountId = draft.accountId
      to = draft.to
      cc = draft.cc
      bcc = draft.bcc
      subject = draft.subject
      bodyHTML = draft.bodyHTML
      bodyText = draft.bodyText
      rawHTML = draft.bodyHTML
      showCarbonCopyFields = !draft.cc.isEmpty || !draft.bcc.isEmpty
      return
    }

    if accountId.isEmpty {
      accountId = model.selectedAccountID ?? model.accounts.first?.id ?? ""
    }
  }

  private func sendAndDismiss() async {
    let request = SendMessageRequest(
      accountId: accountId,
      to: to,
      cc: cc,
      bcc: bcc,
      subject: subject,
      bodyText: outgoingBodyText,
      bodyHTML: outgoingBodyHTML,
      trackOpens: trackOpens,
      replyToEmailID: model.composeDraft?.replyToEmailID
    )
    let sent = await model.send(request)
    if sent {
      model.composeDraft = nil
      dismiss()
    }
  }
}

private struct RecipientSuggestionField: View {
  @Environment(AppModel.self) private var model
  var placeholder: String
  @Binding var text: String

  @FocusState private var isFocused: Bool
  @State private var suggestions: [RecipientSuggestion] = []
  @State private var suggestionTask: Task<Void, Never>?

  init(_ placeholder: String, text: Binding<String>) {
    self.placeholder = placeholder
    self._text = text
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      TextField(placeholder, text: $text)
        #if os(iOS)
        .textInputAutocapitalization(.never)
        .keyboardType(.emailAddress)
        .autocorrectionDisabled()
        #else
        .textFieldStyle(.plain)
        #endif
        .focused($isFocused)
        .onChange(of: text) { _, value in
          scheduleSuggestions(for: value)
        }
        .onChange(of: isFocused) { _, focused in
          if focused {
            scheduleSuggestions(for: text)
          } else {
            suggestionTask?.cancel()
            suggestions = []
          }
        }

      if isFocused && !suggestions.isEmpty {
        VStack(spacing: 0) {
          ForEach(suggestions) { suggestion in
            Button {
              accept(suggestion)
            } label: {
              HStack(spacing: 10) {
                AvatarView(
                  name: suggestion.title,
                  email: suggestion.email,
                  urlString: suggestion.avatarURL,
                  size: 28,
                  prefersLogo: true
                )

                VStack(alignment: .leading, spacing: 1) {
                  Text(suggestion.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                  Text(suggestion.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }

                Spacer(minLength: 8)
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if suggestion.id != suggestions.last?.id {
              Divider()
                .padding(.leading, 48)
            }
          }
        }
        .background(ComposerSurface.suggestionBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(ComposerSurface.borderColor, lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.08), radius: 8, y: 4)
      }
    }
    .onDisappear {
      suggestionTask?.cancel()
    }
  }

  private func scheduleSuggestions(for value: String) {
    suggestionTask?.cancel()
    let query = currentRecipientQuery(in: value)
    guard isFocused, query.count >= 2 else {
      suggestions = []
      return
    }

    suggestionTask = Task {
      try? await Task.sleep(for: .milliseconds(260))
      guard !Task.isCancelled else { return }
      let results = await model.recipientSuggestions(matching: query)
      guard !Task.isCancelled else { return }
      let usedEmails = selectedRecipientEmails(in: value)
      let filtered = results.filter { !usedEmails.contains($0.email.lowercased()) }
      await MainActor.run {
        suggestions = Array(filtered.prefix(6))
      }
    }
  }

  private func accept(_ suggestion: RecipientSuggestion) {
    text = replacingCurrentRecipientToken(in: text, with: suggestion.formattedAddress)
    suggestions = []
  }

  private func currentRecipientQuery(in value: String) -> String {
    let token = value.components(separatedBy: CharacterSet(charactersIn: ",;")).last ?? value
    let addressFragment = token.split(separator: "<", omittingEmptySubsequences: false).last.map(String.init) ?? token
    return addressFragment
      .replacingOccurrences(of: ">", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func replacingCurrentRecipientToken(in value: String, with replacement: String) -> String {
    var parts = value.components(separatedBy: CharacterSet(charactersIn: ",;"))
    if parts.isEmpty {
      return "\(replacement), "
    }
    parts[parts.count - 1] = replacement
    return parts
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .joined(separator: ", ") + ", "
  }

  private func selectedRecipientEmails(in value: String) -> Set<String> {
    let values = value.components(separatedBy: CharacterSet(charactersIn: ",;"))
    return Set(values.compactMap { item in
      let trimmed = item.trimmingCharacters(in: .whitespacesAndNewlines)
      if let start = trimmed.lastIndex(of: "<"), let end = trimmed.lastIndex(of: ">"), start < end {
        return String(trimmed[trimmed.index(after: start)..<end]).lowercased()
      }
      return trimmed.contains("@") ? trimmed.lowercased() : nil
    })
  }
}

enum ComposerEditorMode: String, CaseIterable, Identifiable {
  case write
  case html

  var id: String { rawValue }

  var title: String {
    switch self {
    case .write: "Write"
    case .html: "HTML"
    }
  }
}

private enum ComposerEditorCommandKind {
  case bold
  case italic
  case underline
  case unorderedList
  case orderedList
  case quote
  case clearFormatting

  var script: String {
    switch self {
    case .bold:
      return "document.execCommand('bold', false, null);"
    case .italic:
      return "document.execCommand('italic', false, null);"
    case .underline:
      return "document.execCommand('underline', false, null);"
    case .unorderedList:
      return "document.execCommand('insertUnorderedList', false, null);"
    case .orderedList:
      return "document.execCommand('insertOrderedList', false, null);"
    case .quote:
      return "document.execCommand('formatBlock', false, 'blockquote');"
    case .clearFormatting:
      return "document.execCommand('removeFormat', false, null);"
    }
  }
}

private struct ComposerEditorCommand: Equatable {
  let id = UUID()
  var kind: ComposerEditorCommandKind
}

struct ComposerEditor: View {
  @Binding var mode: ComposerEditorMode
  @Binding var bodyHTML: String
  @Binding var bodyText: String
  @Binding var rawHTML: String
  @State private var pendingCommand: ComposerEditorCommand?

  var body: some View {
    VStack(spacing: 0) {
      editorToolbar

      Divider()

      Group {
        switch mode {
        case .write:
          RichTextWebEditor(
            html: $bodyHTML,
            plainText: $bodyText,
            pendingCommand: $pendingCommand
          )
        case .html:
          TextEditor(text: $rawHTML)
            .font(.system(.body, design: .monospaced))
            #if os(iOS)
            .textInputAutocapitalization(.never)
            #endif
            .padding(10)
        }
      }
      .frame(minHeight: 260)
    }
    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(.quaternary)
    }
    .onChange(of: mode) { oldValue, newValue in
      if newValue == .html {
        rawHTML = bodyHTML
      } else if oldValue == .html {
        bodyHTML = rawHTML
        bodyText = rawHTML.htmlPlainText
      }
    }
  }

  private var editorToolbar: some View {
    #if os(iOS)
    ScrollView(.horizontal, showsIndicators: false) {
      editorToolbarContent
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }
    .background(ComposerSurface.toolbarBackground)
    #else
    editorToolbarContent
      .padding(.horizontal, 10)
      .padding(.vertical, 8)
      .background(ComposerSurface.toolbarBackground)
    #endif
  }

  private var editorToolbarContent: some View {
    HStack(spacing: 8) {
      Picker("Editor mode", selection: $mode) {
        ForEach(ComposerEditorMode.allCases) { mode in
          Text(mode.title).tag(mode)
        }
      }
      .labelsHidden()
      .pickerStyle(.segmented)
      .frame(width: 136)

      Divider()
        .frame(height: 20)

      editorButton("Bold", systemImage: "bold", command: .bold)
      editorButton("Italic", systemImage: "italic", command: .italic)
      editorButton("Underline", systemImage: "underline", command: .underline)

      Divider()
        .frame(height: 20)

      editorButton("Bulleted List", systemImage: "list.bullet", command: .unorderedList)
      editorButton("Numbered List", systemImage: "list.number", command: .orderedList)
      editorButton("Quote", systemImage: "quote.opening", command: .quote)

      Spacer(minLength: 8)

      editorButton("Clear Formatting", systemImage: "eraser", command: .clearFormatting)
    }
  }

  private func editorButton(_ title: String, systemImage: String, command: ComposerEditorCommandKind) -> some View {
    Button {
      pendingCommand = ComposerEditorCommand(kind: command)
    } label: {
      Image(systemName: systemImage)
        .frame(width: 22, height: 22)
    }
    .buttonStyle(.borderless)
    .help(title)
    .disabled(mode == .html)
  }
}

private struct RichTextWebEditor {
  @Binding var html: String
  @Binding var plainText: String
  @Binding var pendingCommand: ComposerEditorCommand?
}

#if os(macOS)
extension RichTextWebEditor: NSViewRepresentable {
  func makeCoordinator() -> Coordinator {
    Coordinator(html: $html, plainText: $plainText)
  }

  func makeNSView(context: Context) -> WKWebView {
    context.coordinator.makeWebView()
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.update(webView, html: html, command: pendingCommand)
  }
}
#else
extension RichTextWebEditor: UIViewRepresentable {
  func makeCoordinator() -> Coordinator {
    Coordinator(html: $html, plainText: $plainText)
  }

  func makeUIView(context: Context) -> WKWebView {
    context.coordinator.makeWebView()
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    context.coordinator.update(webView, html: html, command: pendingCommand)
  }
}
#endif

private extension RichTextWebEditor {
  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private var html: Binding<String>
    private var plainText: Binding<String>
    private var isLoaded = false
    private var lastKnownHTML = ""
    private var lastCommandID: UUID?

    init(html: Binding<String>, plainText: Binding<String>) {
      self.html = html
      self.plainText = plainText
    }

    func makeWebView() -> WKWebView {
      let contentController = WKUserContentController()
      contentController.add(self, name: "composer")

      let configuration = WKWebViewConfiguration()
      configuration.userContentController = contentController
      configuration.defaultWebpagePreferences.allowsContentJavaScript = true

      let webView = WKWebView(frame: .zero, configuration: configuration)
      webView.navigationDelegate = self
      #if os(macOS)
      webView.setValue(false, forKey: "drawsBackground")
      #else
      webView.isOpaque = false
      webView.backgroundColor = .clear
      webView.scrollView.backgroundColor = .clear
      webView.scrollView.contentInsetAdjustmentBehavior = .never
      webView.scrollView.keyboardDismissMode = .interactive
      #endif
      webView.loadHTMLString(Self.document(html: html.wrappedValue), baseURL: nil)
      return webView
    }

    func update(_ webView: WKWebView, html: String, command: ComposerEditorCommand?) {
      guard isLoaded else { return }

      if html != lastKnownHTML {
        setEditorHTML(html, in: webView)
      }

      if let command, command.id != lastCommandID {
        lastCommandID = command.id
        webView.evaluateJavaScript("\(command.kind.script) window.composerDidChange();")
      }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      isLoaded = true
      webView.evaluateJavaScript("window.composerDidChange();")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard
        message.name == "composer",
        let payload = message.body as? [String: String]
      else { return }

      let nextHTML = payload["html"] ?? ""
      lastKnownHTML = nextHTML
      html.wrappedValue = nextHTML
      plainText.wrappedValue = payload["text"] ?? ""
    }

    private func setEditorHTML(_ value: String, in webView: WKWebView) {
      guard let data = try? JSONSerialization.data(withJSONObject: [value]),
            let json = String(data: data, encoding: .utf8) else { return }
      lastKnownHTML = value
      webView.evaluateJavaScript("window.setComposerHTML(\(json)[0]);")
    }

    private static func document(html: String) -> String {
      """
      <!doctype html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          :root { color-scheme: light dark; }
          html, body {
            margin: 0;
            width: 100%;
            min-height: 100%;
            background: transparent;
            color: CanvasText;
            font: -apple-system-body;
            overflow-x: hidden;
          }
          body {
            padding: 14px;
            box-sizing: border-box;
          }
          #editor {
            min-height: 232px;
            outline: none;
            line-height: 1.45;
            word-break: break-word;
            overflow-wrap: anywhere;
            -webkit-user-select: text;
            user-select: text;
          }
          #editor:empty::before {
            content: "Write your message...";
            color: color-mix(in srgb, CanvasText 42%, transparent);
          }
          blockquote {
            margin: 8px 0;
            padding-left: 12px;
            border-left: 3px solid color-mix(in srgb, CanvasText 22%, transparent);
            color: color-mix(in srgb, CanvasText 76%, transparent);
          }
          a { color: LinkText; }
          ul, ol { padding-left: 24px; }
        </style>
      </head>
      <body>
        <div id="editor" contenteditable="true" role="textbox" aria-multiline="true"></div>
        <script>
          const editor = document.getElementById('editor');
          function postComposerState() {
            window.webkit.messageHandlers.composer.postMessage({
              html: editor.innerHTML,
              text: editor.innerText
            });
          }
          window.composerDidChange = postComposerState;
          window.setComposerHTML = function(html) {
            editor.innerHTML = html || '';
            postComposerState();
          };
          editor.addEventListener('input', postComposerState);
          editor.addEventListener('blur', postComposerState);
          editor.innerHTML = \(Self.jsonString(html));
          postComposerState();
        </script>
      </body>
      </html>
      """
    }

    private static func jsonString(_ value: String) -> String {
      guard let data = try? JSONSerialization.data(withJSONObject: [value]),
            let json = String(data: data, encoding: .utf8) else {
        return "\"\""
      }
      return "\(json)[0]"
    }
  }
}

enum ComposerSurface {
  static var cardBackground: Color {
    #if os(macOS)
    Color(nsColor: .controlBackgroundColor)
    #else
    Color(uiColor: .secondarySystemGroupedBackground)
    #endif
  }

  static var toolbarBackground: Color {
    #if os(macOS)
    Color(nsColor: .windowBackgroundColor).opacity(0.72)
    #else
    Color(uiColor: .secondarySystemGroupedBackground)
    #endif
  }

  static var suggestionBackground: Color {
    #if os(macOS)
    Color(nsColor: .controlBackgroundColor)
    #else
    Color(uiColor: .tertiarySystemGroupedBackground)
    #endif
  }

  static var borderColor: Color {
    Color.secondary.opacity(0.18)
  }
}

private extension String {
  var trimmedNonEmpty: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
