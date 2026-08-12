// macca.app のランチャー (Cocoa アプリ)
// シェルスクリプトではなく NSApplication として動くことで:
//  - Dock に「起動中」のドットが表示される
//  - 起動中に Dock アイコンをクリックすると macca のページを開き直す
//  - Dock の右クリック →「終了」でサーバも終了する
// サーバ本体 (macca バイナリ or node server.js) を子プロセスとして起動し、
// サーバが終了 (--exit-on-close によるブラウザ閉検知) したらアプリも終了する。
//
// ビルド: build/macca-app/build.sh (ユニバーサルバイナリを生成してコミット済み)

import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  var server: Process?
  var url = "http://127.0.0.1:8323/"
  var stdoutBuf = ""

  // macca.app の親ディレクトリ = リポジトリルート
  var rootDir: String {
    URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent().path
  }

  func findServerCommand() -> (String, [String])? {
    let bin = rootDir + "/macca"
    if FileManager.default.isExecutableFile(atPath: bin) {
      return (bin, ["--open", "--exit-on-close"])
    }
    for node in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
                 "/opt/homebrew/opt/node/bin/node"] {
      if FileManager.default.isExecutableFile(atPath: node) {
        return (node, [rootDir + "/server.js", "--open", "--exit-on-close"])
      }
    }
    return nil
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let (cmd, args) = findServerCommand() else {
      let alert = NSAlert()
      alert.messageText = "macca"
      alert.informativeText = "Node.js または macca バイナリが見つかりません。\nhttps://nodejs.org からインストールしてください。"
      alert.runModal()
      NSApp.terminate(nil)
      return
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: cmd)
    p.arguments = args
    p.currentDirectoryURL = URL(fileURLWithPath: rootDir)
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    // 起動ログから実際の URL (ポート自動フォールバック対応) を拾う
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      guard let self, let s = String(data: handle.availableData, encoding: .utf8), !s.isEmpty else { return }
      self.stdoutBuf += s
      if let range = self.stdoutBuf.range(of: #"macca 起動: (http://[^\s]+)"#, options: .regularExpression) {
        let line = String(self.stdoutBuf[range])
        self.url = String(line.dropFirst("macca 起動: ".count))
        handle.readabilityHandler = nil
      }
    }
    p.terminationHandler = { _ in
      DispatchQueue.main.async { NSApp.terminate(nil) }
    }
    do {
      try p.run()
      server = p
    } catch {
      NSApp.terminate(nil)
    }
  }

  // 起動中に Dock アイコンをクリック → macca のページを開き直す
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if let u = URL(string: url) {
      NSWorkspace.shared.open(u)
    }
    return false
  }

  func applicationWillTerminate(_ notification: Notification) {
    server?.terminate()
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular) // Dock に表示 (起動中ドットが付く)
app.run()
