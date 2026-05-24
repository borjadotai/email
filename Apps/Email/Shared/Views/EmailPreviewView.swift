import SwiftUI
import WebKit

#if os(macOS)
import AppKit
#elseif os(iOS)
import QuickLook
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
  @State private var attachmentBrowserContext: AttachmentBrowserContext?
  @State private var expandedMessageIDs: Set<String> = []
  @State private var revealedSenderEmailID: String?
  @State private var revealedAddressListID: String?
  @State private var bodyContentHeight: CGFloat = 1
  var onCompose: () -> Void

  var body: some View {
    Group {
      if let email = currentSelectedEmail {
        selectedPreview(email)
          .id(email.id)
          .transition(.opacity)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
          .background(.background)
          .onChange(of: email.id) { _, _ in
            previewMode = .rendered
            expandedMessageIDs = [email.id]
            revealedSenderEmailID = nil
            revealedAddressListID = nil
            bodyContentHeight = 1
          }
          .onChange(of: previewMode) { _, _ in
            bodyContentHeight = 1
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
      } else if model.selectedEmailID != nil {
        loadingPreview
      } else {
        ContentUnavailableView("Select a Message", systemImage: "envelope.open")
          .toolbar {
            Button(action: onCompose) {
              Image(systemName: "square.and.pencil")
            }
          }
      }
    }
    .animation(.easeInOut(duration: 0.16), value: previewIdentity)
    .sheet(item: $attachmentBrowserContext) { context in
      AttachmentBrowserSheet(context: context)
        .environment(model)
    }
  }

  private var currentSelectedEmail: EmailDetail? {
    guard let email = model.selectedEmail, email.id == model.selectedEmailID else { return nil }
    return email
  }

  private var previewIdentity: String {
    currentSelectedEmail?.id ?? model.selectedEmailID ?? "none"
  }

  private var loadingPreview: some View {
    Color.clear
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(.background)
      .overlay {
        ProgressView()
          .controlSize(.small)
          .opacity(0.45)
      }
      .transition(.opacity)
  }

  @ViewBuilder
  private func selectedPreview(_ email: EmailDetail) -> some View {
    #if os(iOS)
    iOSSelectedPreview(email)
    #else
    macOSSelectedPreview(email)
    #endif
  }

  private func macOSSelectedPreview(_ email: EmailDetail) -> some View {
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
  }

  #if os(iOS)
  private func iOSSelectedPreview(_ email: EmailDetail) -> some View {
    let messages = model.conversationEmails.isEmpty ? [email] : model.conversationEmails

    return ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        header(email)
          .padding(.horizontal, 20)
          .padding(.top, 14)
          .padding(.bottom, 17)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)

        if messages.count <= 1 {
          bodyContent(email, allowsInternalScroll: false)
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 24)
        } else {
          conversationStack(selected: email, messages: messages)
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 14)
        }
      }
      .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    .animation(.snappy(duration: 0.24), value: messages.map(\.id))
    .animation(.snappy(duration: 0.24), value: expandedMessageIDs)
  }
  #endif

  @ViewBuilder
  private func conversationContent(selected email: EmailDetail) -> some View {
    let messages = model.conversationEmails.isEmpty ? [email] : model.conversationEmails

    if messages.count <= 1 {
      bodyContent(email)
    } else {
      ScrollView {
        conversationStack(selected: email, messages: messages)
        .padding(.horizontal, 28)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
      }
      .animation(.snappy(duration: 0.24), value: messages.map(\.id))
      .animation(.snappy(duration: 0.24), value: expandedMessageIDs)
    }
  }

  private func conversationStack(selected email: EmailDetail, messages: [EmailDetail]) -> some View {
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
  }

  private func header(_ email: EmailDetail) -> some View {
    #if os(iOS)
    let spacing: CGFloat = 11
    #else
    let spacing: CGFloat = 16
    #endif

    return VStack(alignment: .leading, spacing: spacing) {
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
          senderIdentity(email)
          recipientAddressBlock(email)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .layoutPriority(1)

        let attachments = attachmentItems(for: email)
        if !attachments.isEmpty {
          AttachmentHeaderButton(count: attachments.count) {
            showAttachments(for: email)
          }
        }

        #if os(macOS)
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
        #endif
      }

      if !email.labels.isEmpty {
        HStack(spacing: 5) {
          ForEach(email.labels) { label in
            LabelChip(label: label)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func senderIdentity(_ email: EmailDetail) -> some View {
    #if os(iOS)
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .center, spacing: 6) {
        Text(email.senderName)
          .font(.headline)
          .lineLimit(1)
          .layoutPriority(1)

        Text(email.senderEmail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .contentShape(Rectangle())
      .onTapGesture {
        withAnimation(.snappy(duration: 0.2)) {
          revealedSenderEmailID = revealedSenderEmailID == email.id ? nil : email.id
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Show full sender address")
      .accessibilityAddTraits(.isButton)

      if revealedSenderEmailID == email.id {
        Text(email.senderEmail)
          .font(.caption)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 8)
          .padding(.vertical, 5)
          .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
          .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    #else
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
    #endif
  }

  @ViewBuilder
  private func recipientAddressBlock(_ email: EmailDetail) -> some View {
    #if os(iOS)
    VStack(alignment: .leading, spacing: 5) {
      addressListRow(label: "To", addresses: email.recipients, id: "\(email.id):to")

      if !email.cc.isEmpty {
        addressListRow(label: "Cc", addresses: email.cc, id: "\(email.id):cc")
      }

      if !email.bcc.isEmpty {
        addressListRow(label: "Bcc", addresses: email.bcc, id: "\(email.id):bcc")
      }
    }
    #else
    VStack(alignment: .leading, spacing: 3) {
      addressLineText(label: "To", addresses: email.recipients)

      if !email.cc.isEmpty {
        addressLineText(label: "Cc", addresses: email.cc)
      }

      if !email.bcc.isEmpty {
        addressLineText(label: "Bcc", addresses: email.bcc)
      }
    }
    #endif
  }

  @ViewBuilder
  private func addressLineText(label: String, addresses: [String]) -> some View {
    if !addresses.isEmpty {
      Text("\(label) \(addresses.joined(separator: ", "))")
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .truncationMode(.middle)
    }
  }

  #if os(iOS)
  @ViewBuilder
  private func addressListRow(label: String, addresses: [String], id: String) -> some View {
    if !addresses.isEmpty {
      VStack(alignment: .leading, spacing: 5) {
        Button {
          withAnimation(.snappy(duration: 0.2)) {
            revealedAddressListID = revealedAddressListID == id ? nil : id
          }
        } label: {
          HStack(spacing: 0) {
            Text(addressPrefix(label: label, addresses: addresses))
              .lineLimit(1)
              .layoutPriority(2)

            if addresses.count > 1 {
              Text(addresses.dropFirst().joined(separator: ", "))
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(0)
            }
          }
          .font(.caption)
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) addresses")
        .accessibilityAddTraits(.isButton)

        if revealedAddressListID == id {
          VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(addresses.enumerated()), id: \.offset) { _, address in
              Text(address)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
          }
          .transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
    }
  }

  private func addressPrefix(label: String, addresses: [String]) -> String {
    guard let first = addresses.first else { return "\(label) " }
    return addresses.count > 1 ? "\(label) \(first), " : "\(label) \(first)"
  }
  #endif

  @ViewBuilder
  private func bodyContent(_ email: EmailDetail, allowsInternalScroll: Bool = true) -> some View {
    switch previewMode {
    case .rendered:
      if allowsInternalScroll {
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
      } else {
        #if os(iOS)
        EmailHTMLPreview(
          html: renderedHTML(for: email),
          isScrollEnabled: false,
          contentHeight: $bodyContentHeight
        )
        .frame(height: max(resolvedBodyContentHeight(for: email), 120), alignment: .topLeading)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .clipped()
        #else
        EmptyView()
        #endif
      }
    case .raw:
      if allowsInternalScroll {
        ScrollView {
          rawBody(email)
            .padding(28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      } else {
        rawBody(email)
      }
    }
  }

  private func resolvedBodyContentHeight(for email: EmailDetail) -> CGFloat {
    bodyContentHeight > 1 ? bodyContentHeight : estimatedEmailBodyContentHeight(for: email)
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
      return HTMLMailDocument.wrap(bodyHTML, prefersMobileLayout: prefersMobileEmailLayout)
    }

    let escaped = email.bodyText.htmlEscaped
    return HTMLMailDocument.wrap("<pre class=\"plain-text\">\(escaped)</pre>", prefersMobileLayout: prefersMobileEmailLayout)
  }

  private var prefersMobileEmailLayout: Bool {
    #if os(iOS)
    true
    #else
    false
    #endif
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

  private func attachmentItems(for email: EmailDetail) -> [EmailAttachmentItem] {
    let sourceEmails = model.conversationEmails.isEmpty ? [email] : model.conversationEmails
    var seen = Set<String>()
    return sourceEmails.flatMap { message in
      message.visibleAttachments.compactMap { attachment in
        let id = "\(message.id):\(attachment.id)"
        guard seen.insert(id).inserted else { return nil }
        return EmailAttachmentItem(
          emailID: message.id,
          messageSubject: message.subject,
          senderName: message.senderName,
          receivedAt: message.receivedAt,
          attachment: attachment
        )
      }
    }
  }

  private func showAttachments(for email: EmailDetail) {
    let items = attachmentItems(for: email)
    guard !items.isEmpty else { return }
    attachmentBrowserContext = AttachmentBrowserContext(email: email, items: items)
  }
}

private struct AttachmentHeaderButton: View {
  var count: Int
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      ZStack(alignment: .topTrailing) {
        Image(systemName: "paperclip")
          .font(.body.weight(.semibold))
          .frame(width: 34, height: 34)

        if count > 1 {
          Text("\(count)")
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .monospacedDigit()
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(Color.accentColor, in: Capsule())
            .offset(x: 5, y: -5)
        }
      }
      .foregroundStyle(.primary)
      .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(Color.secondary.opacity(0.16), lineWidth: 0.5)
      }
      .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
    .buttonStyle(.plain)
    .help(count == 1 ? "Show attachment" : "Show attachments")
    .accessibilityLabel(count == 1 ? "Show 1 attachment" : "Show \(count) attachments")
  }
}

private struct AttachmentBrowserContext: Identifiable {
  var id: String
  var subject: String
  var items: [EmailAttachmentItem]

  init(email: EmailDetail, items: [EmailAttachmentItem]) {
    id = "\(email.id):\(items.map(\.id).joined(separator: ","))"
    subject = email.subject
    self.items = items
  }
}

private struct EmailAttachmentItem: Identifiable, Hashable {
  var emailID: String
  var messageSubject: String
  var senderName: String
  var receivedAt: String
  var attachment: EmailAttachment

  var id: String {
    "\(emailID):\(attachment.id)"
  }
}

private struct AttachmentBrowserSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  var context: AttachmentBrowserContext

  @State private var previewLoadingID: String?
  @State private var downloadLoadingID: String?
  @State private var previewFile: LocalAttachmentFile?
  @State private var sharedFile: LocalAttachmentFile?
  @State private var cachedFiles: [String: LocalAttachmentFile] = [:]
  @State private var errorMessage: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 10) {
          ForEach(context.items) { item in
            AttachmentBrowserRow(
              item: item,
              isPreviewLoading: previewLoadingID == item.id,
              isDownloadLoading: downloadLoadingID == item.id,
              onPreview: {
                Task { await preview(item) }
              },
              onDownload: {
                Task { await download(item) }
              }
            )
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
      }
      .background(.background)
      .navigationTitle(context.items.count == 1 ? "Attachment" : "Attachments")
      #if os(iOS)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") {
            dismiss()
          }
        }
      }
    }
    #if os(iOS)
    .presentationDetents([.medium, .large])
    .fullScreenCover(item: $previewFile) { file in
      AttachmentPreviewScreen(file: file)
    }
    .sheet(item: $sharedFile) { file in
      ActivityView(items: [file.url])
    }
    #else
    .frame(minWidth: 520, minHeight: 420)
    .sheet(item: $previewFile) { file in
      MacAttachmentPreviewSheet(file: file)
    }
    #endif
    .alert("Attachment unavailable", isPresented: errorBinding) {
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
  private func preview(_ item: EmailAttachmentItem) async {
    previewLoadingID = item.id
    defer { previewLoadingID = nil }

    do {
      previewFile = try await localFile(for: item)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func download(_ item: EmailAttachmentItem) async {
    downloadLoadingID = item.id
    defer { downloadLoadingID = nil }

    do {
      let file = try await localFile(for: item)
      #if os(macOS)
      try save(file)
      #else
      sharedFile = file
      #endif
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func localFile(for item: EmailAttachmentItem) async throws -> LocalAttachmentFile {
    if let file = cachedFiles[item.id], FileManager.default.fileExists(atPath: file.url.path) {
      return file
    }

    let data = try await model.apiClient.downloadAttachment(
      emailId: item.emailID,
      attachmentId: item.attachment.id
    )
    let file = LocalAttachmentFile(url: try writeTemporaryFile(data: data, filename: item.attachment.filename))
    cachedFiles[item.id] = file
    return file
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

  #if os(macOS)
  private func save(_ file: LocalAttachmentFile) throws {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = file.url.lastPathComponent
    panel.canCreateDirectories = true
    panel.isExtensionHidden = false
    if panel.runModal() == .OK, let destination = panel.url {
      try FileManager.default.copyItem(at: file.url, to: destination)
    }
  }
  #endif
}

private struct AttachmentBrowserRow: View {
  var item: EmailAttachmentItem
  var isPreviewLoading: Bool
  var isDownloadLoading: Bool
  var onPreview: () -> Void
  var onDownload: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: item.attachment.systemImage)
        .font(.title3)
        .foregroundStyle(.secondary)
        .frame(width: 42, height: 42)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
          RoundedRectangle(cornerRadius: 8, style: .continuous)
            .stroke(Color.secondary.opacity(0.12), lineWidth: 0.5)
        }

      VStack(alignment: .leading, spacing: 4) {
        Text(item.attachment.filename)
          .font(.subheadline.weight(.semibold))
          .lineLimit(1)
          .truncationMode(.middle)

        Text(item.attachment.detailText)
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)

        Text(item.senderName)
          .font(.caption2)
          .foregroundStyle(.tertiary)
          .lineLimit(1)
      }

      Spacer(minLength: 10)

      AttachmentRowActionButton(
        systemImage: "eye",
        accessibilityLabel: "Preview \(item.attachment.filename)",
        isLoading: isPreviewLoading,
        action: onPreview
      )

      AttachmentRowActionButton(
        systemImage: "arrow.down.circle",
        accessibilityLabel: "Save \(item.attachment.filename)",
        isLoading: isDownloadLoading,
        action: onDownload
      )
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary.opacity(0.48), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .stroke(.quaternary, lineWidth: 0.5)
    }
    .contentShape(Rectangle())
    .onTapGesture(perform: onPreview)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Preview \(item.attachment.filename)")
    .accessibilityAddTraits(.isButton)
  }
}

private struct AttachmentRowActionButton: View {
  var systemImage: String
  var accessibilityLabel: String
  var isLoading: Bool
  var action: () -> Void

  var body: some View {
    Button(action: action) {
      Group {
        if isLoading {
          ProgressView()
            .controlSize(.small)
        } else {
          Image(systemName: systemImage)
            .font(.body.weight(.semibold))
        }
      }
      .foregroundStyle(.secondary)
      .frame(width: 32, height: 32)
      .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
      .overlay {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .stroke(Color.secondary.opacity(0.12), lineWidth: 0.5)
      }
      .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(isLoading)
    .accessibilityLabel(accessibilityLabel)
  }
}

#if os(iOS)
private struct AttachmentPreviewScreen: View {
  @Environment(\.dismiss) private var dismiss
  var file: LocalAttachmentFile

  var body: some View {
    NavigationStack {
      QuickLookPreview(url: file.url)
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle(file.url.lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") {
              dismiss()
            }
          }

          ToolbarItem(placement: .primaryAction) {
            ShareLink(item: file.url) {
              Label("Save", systemImage: "square.and.arrow.down")
            }
          }
        }
    }
  }
}

private struct QuickLookPreview: UIViewControllerRepresentable {
  var url: URL

  func makeCoordinator() -> Coordinator {
    Coordinator(url: url)
  }

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ controller: QLPreviewController, context: Context) {
    context.coordinator.url = url
    controller.reloadData()
  }

  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    var url: URL

    init(url: URL) {
      self.url = url
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
      1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
      url as NSURL
    }
  }
}
#else
private struct MacAttachmentPreviewSheet: View {
  @Environment(\.dismiss) private var dismiss
  var file: LocalAttachmentFile

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "doc")
        .font(.system(size: 44))
        .foregroundStyle(.secondary)

      Text(file.url.lastPathComponent)
        .font(.headline)
        .lineLimit(2)
        .multilineTextAlignment(.center)

      HStack {
        Button("Open") {
          openExternalURL(file.url)
        }

        Button("Done") {
          dismiss()
        }
        .keyboardShortcut(.defaultAction)
      }
    }
    .padding(28)
    .frame(width: 360, height: 240)
  }
}
#endif

private struct EmailBlockCandidate: Identifiable {
  var id: String { senderEmail }
  var senderName: String
  var senderEmail: String
  var senderDomain: String?
}

private func estimatedEmailBodyContentHeight(for email: EmailDetail) -> CGFloat {
  if let html = email.bodyHTML?.trimmedNonEmpty {
    let lowercaseHTML = html.lowercased()
    let plainText = html.htmlPlainText
    let imageCount = max(0, lowercaseHTML.components(separatedBy: "<img").count - 1)
    let rowCount = max(0, lowercaseHTML.components(separatedBy: "<tr").count - 1)
    let textLineEstimate = plainText
      .components(separatedBy: .newlines)
      .reduce(0) { count, line in
        count + max(1, Int(ceil(Double(line.count) / 42.0)))
      }
    let textEstimate = CGFloat(textLineEstimate) * 21 + 48
    let mediaEstimate = CGFloat(min(imageCount, 8)) * 120
    let tableSpacingEstimate = CGFloat(min(rowCount, 50)) * 4
    return min(max(360, textEstimate + mediaEstimate + tableSpacingEstimate), 5_000)
  }

  let lineCount = email.bodyText.components(separatedBy: .newlines).count
  let textEstimate = CGFloat(email.bodyText.count) / 42 * 20 + CGFloat(lineCount) * 8 + 40
  return min(max(120, textEstimate), 5_000)
}

private struct ConversationMessageRow: View {
  var email: EmailDetail
  var isExpanded: Bool
  var isSelected: Bool
  var previewMode: EmailPreviewMode
  var onToggle: () -> Void
  var onReply: () -> Void
  @State private var bodyContentHeight: CGFloat = 1

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
              Text(email.snippet.mailPreviewText)
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
    .onChange(of: email.id) { _, _ in
      bodyContentHeight = 1
    }
    .onChange(of: previewMode) { _, _ in
      bodyContentHeight = 1
    }
  }

  @ViewBuilder
  private var messageBody: some View {
    switch previewMode {
    case .rendered:
      #if os(iOS)
      EmailHTMLPreview(
        html: renderedHTML,
        isScrollEnabled: false,
        contentHeight: $bodyContentHeight
      )
      .frame(height: max(resolvedBodyContentHeight, 120), alignment: .topLeading)
      .frame(maxWidth: .infinity, alignment: .topLeading)
      .clipped()
      #else
      EmailHTMLPreview(html: renderedHTML)
        .frame(height: 320)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
      #endif
    case .raw:
      Text(rawSource)
        .font(.system(.body, design: .monospaced))
        .lineSpacing(3)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private var resolvedBodyContentHeight: CGFloat {
    bodyContentHeight > 1 ? bodyContentHeight : estimatedEmailBodyContentHeight(for: email)
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
      return HTMLMailDocument.wrap(bodyHTML, prefersMobileLayout: prefersMobileEmailLayout)
    }

    return HTMLMailDocument.wrap(
      "<pre class=\"plain-text\">\(email.bodyText.htmlEscaped)</pre>",
      prefersMobileLayout: prefersMobileEmailLayout
    )
  }

  private var prefersMobileEmailLayout: Bool {
    #if os(iOS)
    true
    #else
    false
    #endif
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
  static func wrap(_ html: String, prefersMobileLayout: Bool = false) -> String {
    let normalizedHTML = normalize(html)

    if normalizedHTML.range(of: "<html\\b", options: [.caseInsensitive, .regularExpression]) != nil {
      return injectStyle(into: normalizedHTML, prefersMobileLayout: prefersMobileLayout)
    }

    return """
    <!doctype html>
    <html>
    <head>
    \(style(prefersMobileLayout: prefersMobileLayout))
    </head>
    <body>
    \(normalizedHTML)
    </body>
    </html>
    """
  }

  private static func normalize(_ html: String) -> String {
    var document = html
    let regexOptions: String.CompareOptions = [.caseInsensitive, .regularExpression]

    document = document.replacingOccurrences(
      of: #"(?s)<script\b[^>]*>.*?</script>"#,
      with: "",
      options: regexOptions
    )
    document = document.replacingOccurrences(
      of: #"<script\b[^>]*/\s*>"#,
      with: "",
      options: regexOptions
    )
    document = document.replacingOccurrences(
      of: #"\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)"#,
      with: "",
      options: regexOptions
    )
    document = document.replacingOccurrences(
      of: #"<span\b(?=[^>]*\b(type|orderid|market)=)[^>]*/\s*>"#,
      with: "",
      options: regexOptions
    )
    document = document.replacingOccurrences(
      of: #"<meta\b(?=[^>]*\bname\s*=\s*["']?(color-scheme|supported-color-schemes)["']?)[^>]*>"#,
      with: "",
      options: regexOptions
    )

    return document
  }

  private static func injectStyle(into html: String, prefersMobileLayout: Bool) -> String {
    var document = html
    let style = style(prefersMobileLayout: prefersMobileLayout)

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

  private static func style(prefersMobileLayout: Bool) -> String {
    """
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <style>
    :root {
      color-scheme: light dark;
      supported-color-schemes: light dark;
      --mail-bg: #ffffff;
      --mail-fg: #1d1d1f;
      --mail-muted: #5f6368;
      --mail-link: #0b57d0;
      --mail-border: rgba(60, 64, 67, 0.24);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --mail-bg: #1f1f1f;
        --mail-fg: #f5f5f7;
        --mail-muted: rgba(245, 245, 247, 0.72);
        --mail-link: #8ab4f8;
        --mail-border: rgba(245, 245, 247, 0.22);
      }
    }
    html {
      background: var(--mail-bg);
      color: var(--mail-fg);
    }
    html, body {
      width: 100% !important;
      min-width: 0 !important;
      max-width: 100% !important;
      margin: 0 !important;
      padding: 0 !important;
      font: -apple-system-body;
      overflow-wrap: anywhere;
      -webkit-text-size-adjust: 100%;
    }
    body {
      background: transparent;
      color: var(--mail-fg);
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
      border-left: 3px solid var(--mail-border);
      color: var(--mail-muted);
    }
    a { color: var(--mail-link); }
    @media (prefers-color-scheme: dark) {
      body,
      body :not(img):not(video):not(canvas):not(svg):not(path):not([fill]) {
        color: var(--mail-fg) !important;
      }
      body,
      body div,
      body section,
      body article,
      body main,
      body header,
      body footer,
      body table,
      body tbody,
      body thead,
      body tfoot,
      body tr,
      body td,
      body th,
      body p,
      body span {
        background-color: transparent !important;
      }
      body a,
      body a * {
        color: var(--mail-link) !important;
      }
      body [style*="border"],
      body table,
      body td,
      body th {
        border-color: var(--mail-border) !important;
      }
    }
    \(prefersMobileLayout ? mobileLayoutStyle : "")
  </style>
  """
  }

  private static let mobileLayoutStyle = """
    .nomob {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
    }
    .show,
    .showmob,
    .showmobarrow {
      display: block !important;
      width: 100% !important;
      height: auto !important;
      max-height: none !important;
      overflow: visible !important;
    }
    .show img[width="0"],
    .showmob img[width="0"],
    .showmobarrow img[width="0"],
    img.w100pc[width="0"] {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      height: auto !important;
    }
  """
}

#if os(iOS)
private struct EmailHTMLPreview: UIViewRepresentable {
  var html: String
  var isScrollEnabled = true
  var contentHeight: Binding<CGFloat>?

  func makeUIView(context: Context) -> WKWebView {
    let webView = makeMailWebView(coordinator: context.coordinator)
    webView.scrollView.isScrollEnabled = isScrollEnabled
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {
    webView.scrollView.isScrollEnabled = isScrollEnabled
    context.coordinator.contentHeight = contentHeight
    context.coordinator.load(html, in: webView)
  }

  func makeCoordinator() -> HTMLMailCoordinator {
    HTMLMailCoordinator(contentHeight: contentHeight)
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
  var contentHeight: Binding<CGFloat>?

  init(contentHeight: Binding<CGFloat>? = nil) {
    self.contentHeight = contentHeight
  }

  func load(_ html: String, in webView: WKWebView) {
    guard loadedHTML != html else { return }
    loadedHTML = html
    webView.loadHTMLString(html, baseURL: nil)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    updateContentHeight(in: webView)
    Task { @MainActor [weak self, weak webView] in
      for delay in [120, 350, 900, 1_600, 2_600] {
        try? await Task.sleep(for: .milliseconds(delay))
        guard let webView else { return }
        self?.updateContentHeight(in: webView)
      }
    }
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

  private func updateContentHeight(in webView: WKWebView) {
    guard contentHeight != nil else { return }

    let script = """
    (() => {
      const body = document.body;
      if (!body) return 0;

      const bodyRect = body.getBoundingClientRect();
      let bottom = 0;
      const addRect = (rect) => {
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        bottom = Math.max(bottom, rect.bottom - bodyRect.top);
      };
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity || 1) !== 0;
      };

      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || !isVisible(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const range = document.createRange();
      let node;
      while ((node = walker.nextNode())) {
        range.selectNodeContents(node);
        Array.from(range.getClientRects()).forEach(addRect);
      }
      range.detach();

      body.querySelectorAll("img, video, canvas, iframe, svg, hr").forEach((element) => {
        if (!isVisible(element)) return;
        Array.from(element.getClientRects()).forEach(addRect);
      });

      return Math.ceil(bottom);
    })()
    """
    webView.evaluateJavaScript(script) { [weak self] result, _ in
      guard let self else { return }
      Task { @MainActor in
        let measuredHeight: CGFloat?
        if let number = result as? NSNumber {
          measuredHeight = CGFloat(number.doubleValue)
        } else if let value = result as? Double {
          measuredHeight = CGFloat(value)
        } else {
          measuredHeight = nil
        }

        if let measuredHeight, measuredHeight > 0 {
          self.setContentHeight(measuredHeight)
        }
      }
    }
  }

  private func setContentHeight(_ height: CGFloat) {
    guard height.isFinite, height > 0 else { return }
    let roundedHeight = max(ceil(height), 120)
    if abs((contentHeight?.wrappedValue ?? 0) - roundedHeight) > 1 {
      contentHeight?.wrappedValue = roundedHeight
    }
  }
}

@MainActor
private func makeMailWebView(coordinator: HTMLMailCoordinator) -> WKWebView {
  let preferences = WKWebpagePreferences()
  preferences.allowsContentJavaScript = true

  let configuration = WKWebViewConfiguration()
  configuration.defaultWebpagePreferences = preferences

  let webView = WKWebView(frame: .zero, configuration: configuration)
  webView.navigationDelegate = coordinator

  #if os(iOS)
  webView.isOpaque = false
  webView.backgroundColor = .clear
  webView.scrollView.backgroundColor = .clear
  webView.scrollView.contentInset = .zero
  webView.scrollView.scrollIndicatorInsets = .zero
  webView.scrollView.contentInsetAdjustmentBehavior = .never
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
