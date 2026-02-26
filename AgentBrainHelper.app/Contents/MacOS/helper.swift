import Cocoa

// AgentBrainHelper — keystroke injection for Claude Desktop
// Uses osascript for System Events (reliable for keystroke delivery).
// The key insight: this binary is the Accessibility-permissioned app,
// and osascript runs as a child process inheriting that permission context.
// Usage: helper "message to inject"

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: helper <message>\n", stderr)
    exit(1)
}

let message = CommandLine.arguments[1]

// Check Claude Desktop is running
let apps = NSRunningApplication.runningApplications(withBundleIdentifier: "com.anthropic.claudefordesktop")
guard let claude = apps.first else {
    fputs("Claude Desktop is not running\n", stderr)
    exit(2)
}

// Save clipboard
let pasteboard = NSPasteboard.general
let oldContents = pasteboard.string(forType: .string)

// Set clipboard to our message
pasteboard.clearContents()
pasteboard.setString(message, forType: .string)

// Activate Claude Desktop and wait for it to come to front
claude.activate(options: .activateIgnoringOtherApps)

// Wait for Claude to be frontmost
for _ in 0..<20 {
    Thread.sleep(forTimeInterval: 0.1)
    if claude.isActive { break }
}

if !claude.isActive {
    fputs("Could not activate Claude Desktop\n", stderr)
    pasteboard.clearContents()
    if let old = oldContents { pasteboard.setString(old, forType: .string) }
    exit(3)
}

// Extra delay for window to fully render
Thread.sleep(forTimeInterval: 0.5)

// Use osascript for keystroke injection via System Events
let script = """
tell application "System Events"
    tell process "Claude"
        set frontmost to true
        delay 0.3
        keystroke "v" using command down
        delay 0.5
        key code 36
    end tell
end tell
"""

let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
task.arguments = ["-e", script]

let outPipe = Pipe()
let errPipe = Pipe()
task.standardOutput = outPipe
task.standardError = errPipe

do {
    try task.run()
    task.waitUntilExit()
} catch {
    fputs("Failed to run osascript: \(error)\n", stderr)
    pasteboard.clearContents()
    if let old = oldContents { pasteboard.setString(old, forType: .string) }
    exit(4)
}

if task.terminationStatus != 0 {
    let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
    let errStr = String(data: errData, encoding: .utf8) ?? "unknown error"
    fputs("osascript error: \(errStr)\n", stderr)
    pasteboard.clearContents()
    if let old = oldContents { pasteboard.setString(old, forType: .string) }
    exit(5)
}

// Restore clipboard
Thread.sleep(forTimeInterval: 0.5)
pasteboard.clearContents()
if let old = oldContents {
    pasteboard.setString(old, forType: .string)
}

print("OK")
