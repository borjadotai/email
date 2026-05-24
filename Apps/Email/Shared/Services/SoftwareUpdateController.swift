#if os(macOS)
import Foundation
import Sparkle

@MainActor
final class SoftwareUpdateController: NSObject {
  private let updaterController: SPUStandardUpdaterController

  override init() {
    updaterController = SPUStandardUpdaterController(
      startingUpdater: true,
      updaterDelegate: nil,
      userDriverDelegate: nil
    )
    super.init()
  }

  var canCheckForUpdates: Bool {
    updaterController.updater.canCheckForUpdates
  }

  func checkForUpdates() {
    updaterController.checkForUpdates(nil)
  }
}
#endif
