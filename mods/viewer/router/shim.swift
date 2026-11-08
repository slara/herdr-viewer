// The app macOS opens PDFs, Markdown and images with, once Cmd-click support is
// installed. It holds no logic: each "open documents" Apple Event is passed to
// router.py with the bundle id of the app that was in front, and router.py
// decides where the files go.
//
// Run from a shell, it reads and writes Launch Services defaults for router.py:
//   herdr-viewer get UTI          print the bundle id that opens UTI
//   herdr-viewer set UTI BUNDLE   make BUNDLE the app that opens UTI
import AppKit
import CoreServices
import UniformTypeIdentifiers

let routerScript = NSString(string: "~/.config/herdr-app/mods/viewer/router/router.py").expandingTildeInPath

let args = CommandLine.arguments
if args.count == 3, args[1] == "get" {
  let handler = LSCopyDefaultRoleHandlerForContentType(args[2] as CFString, .all)?.takeRetainedValue()
  print((handler as String?) ?? "")
  exit(0)
}
if args.count == 4, args[1] == "set" {
  // macOS takes each change from a different API: an app may make itself the
  // default through NSWorkspace, and hand a type to another app through the
  // C API. Each one ignores, or rejects, the other case.
  if args[3].lowercased() == Bundle.main.bundleIdentifier?.lowercased(), let type = UTType(args[2]) {
    NSWorkspace.shared.setDefaultApplication(at: Bundle.main.bundleURL, toOpen: type) { error in
      exit(error == nil ? 0 : 1)
    }
    RunLoop.main.run()
  }
  exit(LSSetDefaultRoleHandlerForContentType(args[2] as CFString, .all, args[3] as CFString) == noErr ? 0 : 1)
}

// Launch Services starts the app with a plain PATH; router.py needs herdr-app and python3.
func forward(_ files: [String], front: String) {
  let task = Process()
  task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  task.arguments = ["python3", routerScript, "open", "--front", front] + files
  var env = ProcessInfo.processInfo.environment
  let extra = [NSString(string: "~/.local/bin").expandingTildeInPath, "/opt/homebrew/bin", "/usr/local/bin"]
  env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
  task.environment = env
  try? task.run()
  task.waitUntilExit()
}

final class Forwarder: NSObject, NSApplicationDelegate {
  // AppKit installs its own document handlers while launching; this one replaces them.
  func applicationWillFinishLaunching(_ note: Notification) {
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(openDocuments(_:reply:)),
      forEventClass: AEEventClass(kCoreEventClass), andEventID: AEEventID(kAEOpenDocuments))
  }

  // Opened with no documents (say, from Finder): nothing to do, so leave.
  func applicationDidFinishLaunching(_ note: Notification) {
    Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { _ in NSApp.terminate(nil) }
  }

  @objc func openDocuments(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
    // The shim is background-only, so the app in front is still the one that asked.
    let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
    var files: [String] = []
    if let list = event.paramDescriptor(forKeyword: keyDirectObject) {
      let items = list.numberOfItems > 0 ? (1...list.numberOfItems).compactMap { list.atIndex($0) } : [list]
      files = items.compactMap { $0.fileURLValue?.path }
    }
    if !files.isEmpty { forward(files, front: front) }
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
let forwarder = Forwarder()
app.delegate = forwarder
app.setActivationPolicy(.prohibited)
app.run()
