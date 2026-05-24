#if os(macOS)
import Foundation

@MainActor
final class LocalServerController {
  private var process: Process?
  private var logHandle: FileHandle?

  deinit {
    process?.terminate()
    try? logHandle?.close()
  }

  func startIfAvailable() async {
    guard process?.isRunning != true else { return }
    if await isHealthy() { return }

    guard let serverRoot = Bundle.main.resourceURL?.appendingPathComponent("Server", isDirectory: true) else {
      return
    }

    let nodeURL = serverRoot.appendingPathComponent("node")
    let mainURL = serverRoot.appendingPathComponent("server/src/main.js")
    let fileManager = FileManager.default
    guard fileManager.isExecutableFile(atPath: nodeURL.path),
          fileManager.fileExists(atPath: mainURL.path) else {
      return
    }

    let dataDirectory = appSupportDirectory()
    let logURL = dataDirectory.appendingPathComponent("server.log")
    fileManager.createFile(atPath: logURL.path, contents: nil)
    let logHandle = try? FileHandle(forWritingTo: logURL)
    _ = try? logHandle?.seekToEnd()

    var environment = ProcessInfo.processInfo.environment
    for (key, value) in bundledEnvironment(from: serverRoot) {
      environment[key] = value
    }
    environment["EMAIL_DATA_DIR"] = environment["EMAIL_DATA_DIR"] ?? dataDirectory.path
    environment["EMAIL_SERVER_HOST"] = "127.0.0.1"
    environment["EMAIL_SERVER_PORT"] = "7331"
    environment["EMAIL_PUBLIC_BASE_URL"] = environment["EMAIL_PUBLIC_BASE_URL"] ?? "http://127.0.0.1:7331"
    environment["PATH"] = [
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      serverRoot.path,
      environment["PATH"] ?? ""
    ].joined(separator: ":")

    let process = Process()
    process.executableURL = nodeURL
    process.arguments = ["--no-warnings", mainURL.path]
    process.currentDirectoryURL = serverRoot
    process.environment = environment
    process.standardOutput = logHandle
    process.standardError = logHandle
    process.terminationHandler = { [weak self] _ in
      Task { @MainActor in
        self?.process = nil
        try? self?.logHandle?.close()
        self?.logHandle = nil
      }
    }

    do {
      try process.run()
      self.process = process
      self.logHandle = logHandle
    } catch {
      try? logHandle?.close()
      NSLog("Email bundled server failed to launch: \(error.localizedDescription)")
      return
    }

    for _ in 0..<50 {
      if await isHealthy() { return }
      try? await Task.sleep(for: .milliseconds(120))
    }

    NSLog("Email bundled server did not become healthy. See \(logURL.path)")
  }

  private func isHealthy() async -> Bool {
    guard let url = URL(string: "http://127.0.0.1:7331/api/health") else {
      return false
    }

    var request = URLRequest(url: url)
    request.timeoutInterval = 0.6

    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
      return (200..<300).contains(statusCode)
    } catch {
      return false
    }
  }

  private func appSupportDirectory() -> URL {
    let baseURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ??
      URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)
    let directory = baseURL.appendingPathComponent("EmailApp", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private func bundledEnvironment(from serverRoot: URL) -> [String: String] {
    let envURL = serverRoot.appendingPathComponent(".env")
    guard let contents = try? String(contentsOf: envURL, encoding: .utf8) else {
      return [:]
    }

    var values: [String: String] = [:]
    for rawLine in contents.split(whereSeparator: \.isNewline) {
      var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !line.isEmpty, !line.hasPrefix("#") else { continue }
      if line.hasPrefix("export ") {
        line = String(line.dropFirst("export ".count))
      }
      guard let equalsIndex = line.firstIndex(of: "=") else { continue }

      let key = line[..<equalsIndex].trimmingCharacters(in: .whitespacesAndNewlines)
      var value = line[line.index(after: equalsIndex)...].trimmingCharacters(in: .whitespacesAndNewlines)
      if value.count >= 2,
         let first = value.first,
         let last = value.last,
         (first == "\"" && last == "\"") || (first == "'" && last == "'") {
        value.removeFirst()
        value.removeLast()
      }

      if !key.isEmpty {
        values[key] = value
      }
    }
    return values
  }
}
#endif
