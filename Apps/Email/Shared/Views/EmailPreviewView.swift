import SwiftUI
import WebKit

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

private enum EmailPreviewMode: String, CaseIterable, Identifiable {
  case rendered
  case raw

  var id: String { rawValue }

  var title: String {
    switch self {
    case .rendered: "HTML"
    case .raw: "Raw"
    }
  }
}

struct EmailPreviewView: View {
  @Environment(AppModel.self) private var model
  @State private var previewMode: EmailPreviewMode = .rendered
  @State private var blockCandidate: EmailBlockCandidate?
  @State private var expandedMessageIDs: Set<String> = []
  var onCompose: () -> Void

  var body: some View {
    Group {
      if let email = model.selectedEmail {
        VStack(alignment: .leading, spacing: 0) {
          VStack(alignment: .leading, spacing: 20) {
            header(email)
          }
          .padding(.horizontal, 28)
          .padding(.top, 28)
          .padding(.bottom, 20)
          .frame(maxWidth: 860, alignment: .leading)

          Divider()

          conversationContent(selected: email)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(.background)
        .onChange(of: email.id) { _, _ in
          previewMode = .rendered
          expandedMessageIDs = [email.id]
        }
        .onAppear {
          if expandedMessageIDs.isEmpty {
            expandedMessageIDs = [email.id]
          }
        }
        .toolbar {
          ToolbarItemGroup {
            #if os(macOS)
            Picker("Preview", selection: $previewMode) {
              ForEach(EmailPreviewMode.allCases) { mode in
                Text(mode.title).tag(mode)
              }
            }
            .pickerStyle(.segmented)
            .frame(width: 116)
            #endif

            Button {
              model.requestReply(to: email)
            } label: {
              Label("Reply", systemImage: "arrowshape.turn.up.left")
            }
            .help("Reply")

            Button {
              Task { await model.toggleSelectedRead() }
            } label: {
              Image(systemName: email.isRead ? "envelope.badge" : "envelope.open")
            }
            .help(email.isRead ? "Mark unread" : "Mark read")

            Button {
              Task { await model.toggleSelectedStar() }
            } label: {
              Image(systemName: email.isStarred ? "star.fill" : "star")
            }
            .help("Star")

            Button {
              Task { await model.archiveSelectedEmail() }
            } label: {
              Label("Archive", systemImage: "archivebox")
            }
            .help("Archive")
            .disabled(model.isArchiving)

            #if os(macOS)
            Menu {
              ForEach(model.labels) { label in
                Button {
                  Task { await model.toggleLabel(label) }
                } label: {
                  let isApplied = email.labels.contains(where: { $0.id == label.id })
                  Label(label.name, systemImage: isApplied ? "checkmark.circle.fill" : "circle")
                }
              }
            } label: {
              Label("Labels", systemImage: "tag")
            }
            .help("Labels")

            Menu {
              ForEach(model.mailboxes.filter { $0.accountId == email.accountId }) { mailbox in
                Button {
                  Task { await model.moveSelectedEmail(to: mailbox) }
                } label: {
                  Label(mailbox.name, systemImage: mailbox.id == email.mailboxId ? "checkmark.circle.fill" : "folder")
                }
              }
            } label: {
              Label("Move", systemImage: "folder")
            }
            .help("Move")

            Button {
              Task { await model.markSelectedSpam() }
            } label: {
              Label("Mark as Spam", systemImage: "exclamationmark.octagon")
            }
            .help("Mark as Spam")

            Button {
              showBlockDialog(for: email)
            } label: {
              Label("Block Sender", systemImage: "hand.raised.slash")
            }
            .help("Block Sender")
            #else
            Menu {
              Section("Preview") {
                ForEach(EmailPreviewMode.allCases) { mode in
                  Button {
                    previewMode = mode
                  } label: {
                    if previewMode == mode {
                      Label(mode.title, systemImage: "checkmark")
                    } else {
                      Text(mode.title)
                    }
                  }
                }
              }

              Section("Labels") {
                ForEach(model.labels) { label in
                  Button {
                    Task { await model.toggleLabel(label) }
                  } label: {
                    let isApplied = email.labels.contains(where: { $0.id == label.id })
                    Label(label.name, systemImage: isApplied ? "checkmark.circle.fill" : "circle")
                  }
                }
              }

              Section("Move") {
                ForEach(model.mailboxes.filter { $0.accountId == email.accountId }) { mailbox in
                  Button {
                    Task { await model.moveSelectedEmail(to: mailbox) }
                  } label: {
                    Label(mailbox.name, systemImage: mailbox.id == email.mailboxId ? "checkmark.circle.fill" : "folder")
                  }
                }
              }

              Button {
                Task { await model.markSelectedSpam() }
              } label: {
                Label("Mark as Spam", systemImage: "exclamationmark.octagon")
              }

              Button {
                showBlockDialog(for: email)
              } label: {
                Label("Block Sender", systemImage: "hand.raised.slash")
              }
            } label: {
              Label("More", systemImage: "ellipsis.circle")
            }
            .help("More")
            #endif
          }
        }
        .sheet(item: $blockCandidate) { candidate in
          BlockSenderSheet(candidate: candidate)
            .environment(model)
        }
      } else {
        ContentUnavailableView("Select a Message", systemImage: "envelope.open")
          .toolbar {
            Button(action: onCompose) {
              Image(systemName: "square.and.pencil")
            }
          }
      }
    }
  }

  @ViewBuilder
  private func conversationContent(selected email: EmailDetail) -> some View {
    let messages = model.conversationEmails.isEmpty ? [email] : model.conversationEmails

    if messages.count <= 1 {
      bodyContent(email)
    } else {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          HStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right")
              .foregroundStyle(.secondary)
            Text("\(messages.count) messages")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.secondary)
            Spacer()
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.bottom, 12)

          Divider()
            .frame(maxWidth: .infinity)

          ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
            ConversationMessageRow(
              email: message,
              isExpanded: expandedMessageIDs.contains(message.id),
              isSelected: message.id == email.id,
              previewMode: previewMode,
              onToggle: {
                withAnimation(.snappy(duration: 0.24)) {
                  if expandedMessageIDs.contains(message.id) {
                    expandedMessageIDs.remove(message.id)
                  } else {
                    expandedMessageIDs.insert(message.id)
                  }
                }
              },
              onReply: {
                model.requestReply(to: message)
              }
            )
            .transition(.asymmetric(
              insertion: .move(edge: .bottom).combined(with: .opacity),
              removal: .opacity
            ))

            if index < messages.count - 1 {
              Divider()
                .frame(maxWidth: .infinity)
            }
          }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .animation(.snappy(duration: 0.24), value: messages.map(\.id))
      .animation(.snappy(duration: 0.24), value: expandedMessageIDs)
    }
  }

  private func header(_ email: EmailDetail) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(email.subject)
        .font(.title2.weight(.semibold))
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)

      HStack(alignment: .top, spacing: 12) {
        AvatarView(
          name: email.senderName,
          email: email.senderEmail,
          urlString: email.senderAvatarURL,
          size: 40,
          prefersLogo: true
        )

        VStack(alignment: .leading, spacing: 6) {
          Text(email.senderName)
            .font(.headline)
            .lineLimit(1)

          Text(email.senderEmail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .lineLimit(1)
            .truncationMode(.middle)
            .layoutPriority(1)

          Text("To \(email.recipients.joined(separator: ", "))")
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .layoutPriority(1)

        VStack(alignment: .trailing, spacing: 6) {
          Text(MailDateFormatter.listTimestamp(email.receivedAt))
            .font(.caption)
            .foregroundStyle(.secondary)
            .monospacedDigit()

          if let openedAt = email.openedAt {
            Label(MailDateFormatter.listTimestamp(openedAt), systemImage: "eye")
              .font(.caption)
              .foregroundStyle(.secondary)
          }
        }
      }

      if !email.labels.isEmpty {
        HStack(spacing: 5) {
          ForEach(email.labels) { label in
            LabelChip(label: label)
          }
        }
      }

      if !email.visibleAttachments.isEmpty {
        EmailAttachmentList(email: email)
      }
    }
  }

  @ViewBuilder
  private func bodyContent(_ email: EmailDetail) -> some View {
    switch previewMode {
    case .rendered:
      GeometryReader { proxy in
        EmailHTMLPreview(html: renderedHTML(for: email))
          .frame(
            width: proxy.size.width,
            height: proxy.size.height,
            alignment: .topLeading
          )
      }
      .padding(.horizontal, 28)
      .padding(.vertical, 20)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .clipped()
    case .raw:
      ScrollView {
        rawBody(email)
          .padding(28)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private func rawBody(_ email: EmailDetail) -> some View {
    Text(rawSource(for: email))
      .font(.system(.body, design: .monospaced))
      .lineSpacing(3)
      .textSelection(.enabled)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func renderedHTML(for email: EmailDetail) -> String {
    if let bodyHTML = email.bodyHTML?.trimmedNonEmpty {
      return HTMLMailDocument.wrap(bodyHTML)
    }

    let escaped = email.bodyText.htmlEscaped
    return HTMLMailDocument.wrap("<pre class=\"plain-text\">\(escaped)</pre>")
  }

  private func rawSource(for email: EmailDetail) -> String {
    email.bodyHTML?.trimmedNonEmpty ?? email.bodyText
  }

  private func showBlockDialog(for email: EmailDetail) {
    blockCandidate = EmailBlockCandidate(
      senderName: email.senderName,
      senderEmail: email.senderEmail,
      senderDomain: email.senderEmail.emailDomain
    )
  }
}

private struct EmailBlockCandidate: Identifiable {
  var id: String { senderEmail }
  var senderName: String
  var senderEmail: String
  var senderDomain: String?
}

private struct ConversationMessageRow: View {
  var email: EmailDetail
  var isExpanded: Bool
  var isSelected: Bool
  var previewMode: EmailPreviewMode
  var onToggle: () -> Void
  var onReply: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button(action: onToggle) {
        HStack(alignment: .top, spacing: 12) {
          AvatarView(
            name: email.senderName,
            email: email.senderEmail,
            urlString: email.senderAvatarURL,
            size: 36,
            prefersLogo: true
          )

          VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
              Text(email.senderName)
                .font(.headline)
                .lineLimit(1)
              Text(email.mailboxRole == "sent" ? "sent" : "received")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(.quaternary, in: Capsule())
            }

            Text(subtitle)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(2)

            if !isExpanded {
              Text(email.snippet)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .padding(.top, 2)
            }
          }

          Spacer(minLength: 12)

          VStack(alignment: .trailing, spacing: 8) {
            Text(MailDateFormatter.listTimestamp(email.receivedAt))
              .font(.caption.monospacedDigit())
              .foregroundStyle(.secondary)

            Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.tertiary)
          }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 14)
        .padding(.leading, 12)
        .padding(.trailing, 2)
      }
      .buttonStyle(.plain)

      if isExpanded {
        VStack(alignment: .leading, spacing: 12) {
          if !email.visibleAttachments.isEmpty {
            EmailAttachmentList(email: email)
          }

          messageBody

          HStack {
            Button(action: onReply) {
              Label("Reply", systemImage: "arrowshape.turn.up.left")
            }
            .buttonStyle(.bordered)

            Spacer()
          }
        }
        .padding(.horizontal, 0)
        .padding(.bottom, 18)
        .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      if isSelected {
        Color.accentColor.opacity(0.055)
      }
    }
    .overlay(alignment: .leading) {
      if isSelected {
        Rectangle()
          .fill(Color.accentColor)
          .frame(width: 2)
          .padding(.vertical, 12)
      }
    }
  }

  @ViewBuilder
  private var messageBody: some View {
    switch previewMode {
    case .rendered:
      EmailHTMLPreview(html: renderedHTML)
        .frame(height: 320)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    case .raw:
      Text(rawSource)
        .font(.system(.body, design: .monospaced))
        .lineSpacing(3)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var subtitle: String {
    let recipients = email.recipients.joined(separator: ", ")
    if email.mailboxRole == "sent" {
      return recipients.isEmpty ? email.senderEmail : "To \(recipients)"
    }
    return email.senderEmail
  }

  private var renderedHTML: String {
    if let bodyHTML = email.bodyHTML?.trimmedNonEmpty {
      return HTMLMailDocument.wrap(bodyHTML)
    }

    return HTMLMailDocument.wrap("<pre class=\"plain-text\">\(email.bodyText.htmlEscaped)</pre>")
  }

  private var rawSource: String {
    email.bodyHTML?.trimmedNonEmpty ?? email.bodyText
  }
}

private struct BlockSenderSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var candidate: EmailBlockCandidate

  var body: some View {
    VStack(alignment: .leading, spacing: 22) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: "hand.raised.slash")
          .font(.title2)
          .foregroundStyle(.red)
          .frame(width: 36, height: 36)
          .background(.red.opacity(0.12), in: Circle())

        VStack(alignment: .leading, spacing: 6) {
          Text("Block Sender")
            .font(.title2.weight(.semibold))
          Text(candidate.senderName)
            .font(.headline)
          Text(candidate.senderEmail)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
        }
      }

      VStack(spacing: 10) {
        blockButton(
          title: "Block Email Address",
          subtitle: candidate.senderEmail,
          systemImage: "at",
          scope: .email
        )

        if let domain = candidate.senderDomain {
          blockButton(
            title: "Block Domain",
            subtitle: domain,
            systemImage: "globe",
            scope: .domain
          )
        }
      }

      HStack {
        Spacer()
        Button("Cancel", role: .cancel) {
          dismiss()
        }
        .keyboardShortcut(.cancelAction)
      }
    }
    .padding(24)
    .frame(minWidth: 340, idealWidth: 420, maxWidth: 460, maxHeight: .infinity, alignment: .topLeading)
    #if os(iOS)
    .presentationDetents([.medium])
    .presentationDragIndicator(.visible)
    #endif
  }

  private func blockButton(title: String, subtitle: String, systemImage: String, scope: BlockSenderScope) -> some View {
    Button(role: .destructive) {
      Task {
        await model.blockSelectedSender(scope: scope)
        dismiss()
      }
    } label: {
      HStack(spacing: 12) {
        Image(systemName: systemImage)
          .frame(width: 22)

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.headline)
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }

        Spacer()
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
    }
    .buttonStyle(.bordered)
  }
}

private struct EmailAttachmentList: View {
  @Environment(AppModel.self) private var model
  var email: EmailDetail
  @State private var downloadingAttachmentID: String?
  @State private var sharedFile: LocalAttachmentFile?
  @State private var errorMessage: String?

  private var attachments: [EmailAttachment] {
    email.visibleAttachments
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(spacing: 6) {
        Image(systemName: "paperclip")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
        Text(attachments.count == 1 ? "1 attachment" : "\(attachments.count) attachments")
          .font(.caption.weight(.semibold))
          .foregroundStyle(.secondary)
      }

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(attachments) { attachment in
            AttachmentCard(
              attachment: attachment,
              isDownloading: downloadingAttachmentID == attachment.id
            ) {
              Task { await download(attachment) }
            }
          }
        }
      }
      .scrollClipDisabled()
    }
    #if os(iOS)
    .sheet(item: $sharedFile) { file in
      ActivityView(items: [file.url])
    }
    #endif
    .alert("Download failed", isPresented: errorBinding) {
      Button("OK") {
        errorMessage = nil
      }
    } message: {
      Text(errorMessage ?? "")
    }
  }

  private var errorBinding: Binding<Bool> {
    Binding(
      get: { errorMessage != nil },
      set: { isPresented in
        if !isPresented {
          errorMessage = nil
        }
      }
    )
  }

  @MainActor
  private func download(_ attachment: EmailAttachment) async {
    downloadingAttachmentID = attachment.id
    defer { downloadingAttachmentID = nil }

    do {
      let data = try await model.apiClient.downloadAttachment(
        emailId: email.id,
        attachmentId: attachment.id
      )
      let localURL = try writeTemporaryFile(data: data, filename: attachment.filename)

      #if os(macOS)
      let panel = NSSavePanel()
      panel.nameFieldStringValue = attachment.filename.safeAttachmentFilename
      panel.canCreateDirectories = true
      panel.isExtensionHidden = false
      if panel.runModal() == .OK, let destination = panel.url {
        try data.write(to: destination, options: .atomic)
      }
      #else
      sharedFile = LocalAttachmentFile(url: localURL)
      #endif
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func writeTemporaryFile(data: Data, filename: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("EmailAttachments", isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let url = directory.appendingPathComponent(filename.safeAttachmentFilename)
    try data.write(to: url, options: .atomic)
    return url
  }
}

private struct AttachmentCard: View {
  var attachment: EmailAttachment
  var isDownloading: Bool
  var onDownload: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: attachment.systemImage)
        .font(.title3)
        .foregroundStyle(.secondary)
        .frame(width: 30, height: 30)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 7, style: .continuous))

      VStack(alignment: .leading, spacing: 2) {
        Text(attachment.filename)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
          .truncationMode(.middle)

        Text(attachment.detailText)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      Button(action: onDownload) {
        if isDownloading {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: "arrow.down.circle")
        }
      }
      .buttonStyle(.plain)
      .disabled(isDownloading)
      .accessibilityLabel("Download \(attachment.filename)")
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 9)
    .frame(width: 260, alignment: .leading)
    .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(.quaternary, lineWidth: 0.5)
    }
  }
}

private struct LocalAttachmentFile: Identifiable {
  var id: URL { url }
  var url: URL
}

#if os(iOS)
private struct ActivityView: UIViewControllerRepresentable {
  var items: [Any]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }

  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
#endif

private enum HTMLMailDocument {
  static func wrap(_ html: String) -> String {
    if html.range(of: "<html\\b", options: [.caseInsensitive, .regularExpression]) != nil {
      return injectStyle(into: html)
    }

    return """
    <!doctype html>
    <html>
    <head>
    \(style)
    </head>
    <body>
    \(html)
    </body>
    </html>
    """
  }

  private static func injectStyle(into html: String) -> String {
    var document = html
    if let closingHeadRange = document.range(of: "</head>", options: [.caseInsensitive]) {
      document.insert(contentsOf: style, at: closingHeadRange.lowerBound)
      return document
    }

    if let headRange = document.range(of: "<head[^>]*>", options: [.caseInsensitive, .regularExpression]) {
      document.insert(contentsOf: style, at: headRange.upperBound)
      return document
    }

    if let htmlRange = document.range(of: "<html[^>]*>", options: [.caseInsensitive, .regularExpression]) {
      document.insert(contentsOf: "<head>\(style)</head>", at: htmlRange.upperBound)
      return document
    }

    return document
  }

  private static let style = """
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <style>
    :root { color-scheme: light dark; }
    html, body {
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      background: transparent;
      color: CanvasText;
      font: -apple-system-body;
      overflow-wrap: anywhere;
      -webkit-text-size-adjust: 100%;
    }
    body {
      box-sizing: border-box;
      line-height: 1.48;
    }
    *, *::before, *::after {
      box-sizing: border-box !important;
    }
    body > *,
    div, section, article, main, header, footer,
    table, tbody, thead, tfoot, tr, td, th {
      max-width: 100% !important;
    }
    table {
      width: 100% !important;
      border-collapse: collapse;
    }
    td, th {
      overflow-wrap: anywhere !important;
      word-break: normal;
    }
    [style*="min-width"] {
      min-width: 0 !important;
    }
    img, video, canvas, iframe {
      max-width: 100% !important;
      height: auto !important;
    }
    pre, code, .plain-text {
      white-space: pre-wrap;
      word-break: break-word;
      font: -apple-system-body;
    }
    blockquote {
      margin-left: 0;
      padding-left: 12px;
      border-left: 3px solid rgba(128, 128, 128, 0.35);
      color: color-mix(in srgb, CanvasText 72%, transparent);
    }
    a { color: -webkit-link; }
  </style>
  """
}

#if os(iOS)
private struct EmailHTMLPreview: UIViewRepresentable {
  var html: String

  func makeUIView(context: Context) -> WKWebView {
    makeMailWebView(coordinator: context.coordinator)
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    context.coordinator.load(html, in: webView)
  }

  func makeCoordinator() -> HTMLMailCoordinator {
    HTMLMailCoordinator()
  }
}
#elseif os(macOS)
private struct EmailHTMLPreview: NSViewRepresentable {
  var html: String

  func makeNSView(context: Context) -> WKWebView {
    makeMailWebView(coordinator: context.coordinator)
  }

  func updateNSView(_ webView: WKWebView, context: Context) {
    context.coordinator.load(html, in: webView)
  }

  func makeCoordinator() -> HTMLMailCoordinator {
    HTMLMailCoordinator()
  }
}
#endif

@MainActor
private final class HTMLMailCoordinator: NSObject, WKNavigationDelegate {
  private var loadedHTML: String?

  func load(_ html: String, in webView: WKWebView) {
    guard loadedHTML != html else { return }
    loadedHTML = html
    webView.loadHTMLString(html, baseURL: nil)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
      openExternalURL(url)
      decisionHandler(.cancel)
      return
    }

    decisionHandler(.allow)
  }
}

@MainActor
private func makeMailWebView(coordinator: HTMLMailCoordinator) -> WKWebView {
  let preferences = WKWebpagePreferences()
  preferences.allowsContentJavaScript = false

  let configuration = WKWebViewConfiguration()
  configuration.defaultWebpagePreferences = preferences

  let webView = WKWebView(frame: .zero, configuration: configuration)
  webView.navigationDelegate = coordinator

  #if os(iOS)
  webView.isOpaque = false
  webView.backgroundColor = .clear
  webView.scrollView.backgroundColor = .clear
  webView.scrollView.isScrollEnabled = true
  webView.scrollView.bounces = true
  #elseif os(macOS)
  webView.setValue(false, forKey: "drawsBackground")
  #endif

  return webView
}

@MainActor
private func openExternalURL(_ url: URL) {
  #if os(macOS)
  NSWorkspace.shared.open(url)
  #elseif os(iOS)
  UIApplication.shared.open(url)
  #endif
}

private extension EmailDetail {
  var visibleAttachments: [EmailAttachment] {
    (attachments ?? []).filter { attachment in
      !attachment.isInline || !attachment.filename.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
  }
}

private extension EmailAttachment {
  var detailText: String {
    let type = fileTypeLabel
    guard size > 0 else { return type }
    return "\(type) · \(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))"
  }

  var fileTypeLabel: String {
    if mimeType == "application/pdf" {
      return "PDF"
    }
    if mimeType.hasPrefix("image/") {
      return "Image"
    }
    if mimeType.hasPrefix("text/") {
      return "Text"
    }
    if mimeType.contains("zip") || mimeType.contains("archive") {
      return "Archive"
    }
    let ext = (filename as NSString).pathExtension
    return ext.isEmpty ? "Attachment" : ext.uppercased()
  }

  var systemImage: String {
    if mimeType == "application/pdf" {
      return "doc.richtext"
    }
    if mimeType.hasPrefix("image/") {
      return "photo"
    }
    if mimeType.hasPrefix("text/") {
      return "doc.text"
    }
    if mimeType.contains("zip") || mimeType.contains("archive") {
      return "archivebox"
    }
    return "doc"
  }
}

private extension String {
  var trimmedNonEmpty: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }

  var htmlEscaped: String {
    replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&#39;")
  }

  var emailDomain: String? {
    let parts = split(separator: "@", maxSplits: 1)
    guard parts.count == 2 else { return nil }
    let domain = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
    return domain.isEmpty ? nil : domain.lowercased()
  }

  var safeAttachmentFilename: String {
    let invalid = CharacterSet(charactersIn: "/\\:\n\r")
    let cleaned = components(separatedBy: invalid)
      .joined(separator: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return cleaned.isEmpty ? "Attachment" : cleaned
  }
}
