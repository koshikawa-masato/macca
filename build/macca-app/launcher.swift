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
    // 1) DMG 配布用: バンドル内に同梱されたサーババイナリ (自己完結型)
    if let res = Bundle.main.resourcePath {
      let bundled = res + "/macca-server"
      if FileManager.default.isExecutableFile(atPath: bundled) {
        return (bundled, ["--open", "--exit-on-close"])
      }
    }
    // 2) リポジトリ直下の Go バイナリ
    let bin = rootDir + "/macca"
    if FileManager.default.isExecutableFile(atPath: bin) {
      return (bin, ["--open", "--exit-on-close"])
    }
    // 3) Node.js 版
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

  // 起動中に Dock アイコンをクリックしたとき:
  //  - ページが既に開いている → ブラウザを前面に出すだけ (重複タブを作らない)
  //  - ページが閉じられている → macca のページを開き直す
  // 複数起動したい場合は Finder から macca.app をもう一度開く (ポート自動ずらし)
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    guard let u = URL(string: url) else { return false }
    let statsURL = u.appendingPathComponent("api/stats")
    let task = URLSession.shared.dataTask(with: statsURL) { data, _, _ in
      var clients = 0
      if let data,
         let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
         let c = obj["clients"] as? Int {
        clients = c
      }
      DispatchQueue.main.async {
        if clients > 0, let appURL = NSWorkspace.shared.urlForApplication(toOpen: u) {
          // 既定ブラウザを前面に出す (タブは増やさない)
          NSWorkspace.shared.openApplication(at: appURL, configuration: NSWorkspace.OpenConfiguration())
        } else {
          NSWorkspace.shared.open(u)
        }
      }
    }
    task.resume()
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
