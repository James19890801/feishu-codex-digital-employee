import AppKit
import Foundation
import WebKit

private let dashboardURL = URL(string: "http://127.0.0.1:17655/")!
private let serviceLabels = [
    "com.local.feishu-codex-dashboard",
    "com.local.feishu-codex-digital-employee",
    "com.local.aipro-wechat-poc",
]

@main
final class AIPROApp: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var retryTimer: Timer?
    private var dashboardLoaded = false
    private var browserLaunchInProgress = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSLog("AIPRO launcher started")
        NSApp.setActivationPolicy(.regular)
        configureMenu()
        configureWindow()
        showStartingPage()
        recoverServices()
        beginDashboardProbe()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard dashboardLoaded, !window.isVisible else { return }
        openDashboardInBrowser()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if dashboardLoaded {
            openDashboardInBrowser()
        } else {
            window.makeKeyAndOrderFront(nil)
            showStartingPage()
            recoverServices()
            beginDashboardProbe()
            NSApp.activate(ignoringOtherApps: true)
        }
        return true
    }

    private func configureWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsMagnification = true

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "AIPRO · 基于真人身份运行的AI数字人平台"
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 980, height: 680)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("AIPRO.MainWindow")
        window.makeKeyAndOrderFront(nil)
    }

    private func configureMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu(title: "AIPRO")
        appMenu.addItem(withTitle: "关于 AIPRO", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 AIPRO", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        let reload = viewMenu.addItem(withTitle: "刷新面板", action: #selector(reloadDashboard), keyEquivalent: "r")
        reload.target = self
        let browser = viewMenu.addItem(withTitle: "在浏览器中打开", action: #selector(openInBrowser), keyEquivalent: "b")
        browser.target = self
        viewMenu.addItem(.separator())
        let recover = viewMenu.addItem(withTitle: "恢复后台服务", action: #selector(recoverServicesFromMenu), keyEquivalent: "k")
        recover.target = self
        viewItem.submenu = viewMenu
        NSApp.mainMenu = mainMenu
    }

    private func showStartingPage() {
        let html = """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
        :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;
        background:radial-gradient(circle at 20% 10%,#323081 0,#17172d 38%,#0b0c16 100%);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#fff}
        main{width:min(620px,86vw);padding:52px;border:1px solid #ffffff1f;border-radius:28px;background:#111426cc;box-shadow:0 30px 80px #0008}
        b{display:inline-grid;place-items:center;width:62px;height:62px;border-radius:18px;background:linear-gradient(135deg,#755cff,#28b9ff);font-size:22px;letter-spacing:-1px}
        h1{font-size:34px;margin:24px 0 8px}.sub{color:#b9bfd8;font-size:17px;margin:0}.status{margin-top:34px;padding:18px 20px;border-radius:16px;background:#ffffff0b;color:#dfe4ff}
        i{display:inline-block;width:9px;height:9px;margin-right:10px;border-radius:50%;background:#58e0a3;box-shadow:0 0 18px #58e0a3;animation:p 1.2s infinite alternate}@keyframes p{to{opacity:.35}}
        small{display:block;margin-top:14px;color:#777e9c}</style></head>
        <body><main><b>AI</b><h1>AIPRO</h1><p class="sub">基于真人身份运行的AI数字人平台</p>
        <div class="status"><i></i>正在连接本机控制面板…</div><small>应用会自动恢复后台服务，无需打开 Codex。</small></main></body></html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func recoverServices() {
        let domain = "gui/\(getuid())"
        for label in serviceLabels {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
            process.arguments = ["kickstart", "\(domain)/\(label)"]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try? process.run()
        }
    }

    private func beginDashboardProbe() {
        retryTimer?.invalidate()
        probeDashboard()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
            self?.probeDashboard()
        }
    }

    private func probeDashboard() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:17655/api/status")!)
        request.timeoutInterval = 1.0
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            NSLog("AIPRO dashboard probe status=%d error=%@", statusCode, error?.localizedDescription ?? "none")
            guard let http = response as? HTTPURLResponse, (200..<500).contains(http.statusCode) else { return }
            DispatchQueue.main.async {
                guard let self, !self.dashboardLoaded else { return }
                self.dashboardLoaded = true
                self.retryTimer?.invalidate()
                self.retryTimer = nil
                self.webView.load(URLRequest(url: dashboardURL, cachePolicy: .reloadIgnoringLocalCacheData))
                self.openDashboardInBrowser()
                self.window.orderOut(nil)
            }
        }.resume()
    }

    @objc private func reloadDashboard() {
        dashboardLoaded = false
        showStartingPage()
        recoverServices()
        beginDashboardProbe()
    }

    @objc private func recoverServicesFromMenu() {
        reloadDashboard()
    }

    @objc private func openInBrowser() {
        openDashboardInBrowser()
    }

    private func openDashboardInBrowser() {
        guard !browserLaunchInProgress else { return }
        NSLog("AIPRO opening dashboard in default browser")
        browserLaunchInProgress = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }
            guard let browserURL = NSWorkspace.shared.urlForApplication(toOpen: dashboardURL) else {
                self.browserLaunchInProgress = false
                self.window.makeKeyAndOrderFront(nil)
                return
            }
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = true
            configuration.addsToRecentItems = false
            NSWorkspace.shared.open(
                [dashboardURL],
                withApplicationAt: browserURL,
                configuration: configuration
            ) { browser, error in
                DispatchQueue.main.async {
                    self.browserLaunchInProgress = false
                    guard error == nil else {
                        self.window.makeKeyAndOrderFront(nil)
                        return
                    }
                    browser?.activate(options: [.activateAllWindows])
                    NSApp.terminate(nil)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard self?.browserLaunchInProgress == true else { return }
                NSApp.terminate(nil)
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        dashboardLoaded = false
        showStartingPage()
        beginDashboardProbe()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        dashboardLoaded = false
        showStartingPage()
        beginDashboardProbe()
    }
}
