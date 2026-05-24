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
    NavigationStack {
      Form {
        Section {
          Picker("From", selection: $accountId) {
            ForEach(model.accounts) { account in
              Text(account.email)
                .tag(account.id)
            }
          }

          recipientFields
          TextField("Subject", text: $subject)
        }

        Section {
          ComposerEditor(
            mode: $editorMode,
            bodyHTML: $bodyHTML,
            bodyText: $bodyText,
            rawHTML: $rawHTML
          )
          .frame(minHeight: 320)
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
          .disabled(accountId.isEmpty || to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.isSending)
        }
      }
      .onAppear(perform: loadInitialState)
    }
    #if os(macOS)
    .frame(minWidth: 680, minHeight: 660)
    #endif
  }

  private var recipientFields: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        TextField("To", text: $to)
          #if os(iOS)
          .textInputAutocapitalization(.never)
          .keyboardType(.emailAddress)
          #endif

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
        .opacity(shouldShowCarbonCopyToggle ? 1 : 0)
        .allowsHitTesting(shouldShowCarbonCopyToggle)
        .accessibilityLabel(showCarbonCopyFields ? "Hide Cc and Bcc" : "Show Cc and Bcc")
      }
      #if os(macOS)
      .onHover { isHovering in
        withAnimation(.snappy(duration: 0.16)) {
          isShowingCarbonCopyHover = isHovering
        }
      }
      #endif

      if showCarbonCopyFields || !cc.isEmpty || !bcc.isEmpty {
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
}

private enum ComposerEditorMode: String, CaseIterable, Identifiable {
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

private struct ComposerEditor: View {
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
    HStack(spacing: 6) {
      Picker("Editor mode", selection: $mode) {
        ForEach(ComposerEditorMode.allCases) { mode in
          Text(mode.title).tag(mode)
        }
      }
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
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(.thinMaterial)
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
            min-height: 100%;
            background: transparent;
            color: CanvasText;
            font: -apple-system-body;
          }
          body {
            padding: 16px;
            box-sizing: border-box;
          }
          #editor {
            min-height: 224px;
            outline: none;
            line-height: 1.45;
            word-break: break-word;
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

private extension String {
  var trimmedNonEmpty: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
