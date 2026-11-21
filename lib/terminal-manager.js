/**
 * Terminal Manager - List and close Terminal.app windows via AppleScript
 */

const { execSync } = require("child_process");

// Patterns that indicate a terminal should be protected (not closed)
const PROTECTED_PATTERNS = [
  /server\.js/i,
  /caffeinate/i,
  /node.*server/i,
  /npm\s+start/i,
  /agent-brain.*-zsh/i,  // The main agent-brain terminal
];

/**
 * List all open Terminal.app windows with their properties
 */
function listWindows() {
  try {
    const script = `
tell application "Terminal"
    set windowList to {}
    repeat with i from 1 to count of windows
        set w to window i
        try
            set windowName to name of w
            set isFrontmost to frontmost of w
            set end of windowList to (i as text) & "|||" & windowName & "|||" & (isFrontmost as text)
        end try
    end repeat
    return windowList
end tell
`;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: "utf8",
      timeout: 5000
    }).trim();

    if (!result) return [];

    // Parse the result - format: "1|||name|||true, 2|||name|||false, ..."
    const windows = [];
    const parts = result.split(", ");

    for (const part of parts) {
      const [index, name, frontmost] = part.split("|||");
      if (index && name) {
        const isProtected = PROTECTED_PATTERNS.some(p => p.test(name));
        windows.push({
          index: parseInt(index, 10),
          name: name.trim(),
          frontmost: frontmost === "true",
          protected: isProtected,
          // Extract session name if it looks like a Claude session
          sessionName: extractSessionName(name)
        });
      }
    }

    return windows;
  } catch (err) {
    console.error("[terminal-manager] Error listing windows:", err.message);
    return [];
  }
}

/**
 * Extract a clean session name from a terminal window title
 */
function extractSessionName(windowName) {
  // Terminal titles often look like: "username — ✳ Session Name — claude ..."
  // Try to extract the session name part
  const match = windowName.match(/[—–-]\s*[✳⠂]?\s*([^—–-]+?)\s*[—–-]/);
  if (match) {
    return match[1].trim();
  }
  // Fallback: use the whole name truncated
  return windowName.length > 40 ? windowName.slice(0, 40) + "..." : windowName;
}

/**
 * Focus/surface a Terminal window by its index and center it on screen
 * Returns true if successful, false otherwise
 */
function focusWindow(index) {
  try {
    const script = `
tell application "Terminal"
    activate
    if (count of windows) >= ${index} then
        set w to window ${index}
        set frontmost of w to true

        -- Get screen size and center the window
        tell application "Finder"
            set screenBounds to bounds of window of desktop
            set screenWidth to item 3 of screenBounds
            set screenHeight to item 4 of screenBounds
        end tell

        -- Get current window size
        set windowBounds to bounds of w
        set winWidth to (item 3 of windowBounds) - (item 1 of windowBounds)
        set winHeight to (item 4 of windowBounds) - (item 2 of windowBounds)

        -- Calculate centered position
        set newX to (screenWidth - winWidth) / 2
        set newY to (screenHeight - winHeight) / 2 + 25

        -- Move window to center
        set bounds of w to {newX, newY, newX + winWidth, newY + winHeight}

        return "ok"
    else
        return "not_found"
    end if
end tell
`;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, {
      encoding: "utf8",
      timeout: 5000
    }).trim();

    return result === "ok";
  } catch (err) {
    console.error("[terminal-manager] Error focusing window:", err.message);
    return false;
  }
}

/**
 * Close a Terminal window by its index
 * Returns true if successful, false otherwise
 */
function closeWindow(index) {
  try {
    const script = `
tell application "Terminal"
    if (count of windows) >= ${index} then
        close window ${index}
        return "ok"
    else
        return "not_found"
    end if
end tell
`;
    const result = execSync(`osascript -e '${script}'`, {
      encoding: "utf8",
      timeout: 5000
    }).trim();

    return result === "ok";
  } catch (err) {
    console.error("[terminal-manager] Error closing window:", err.message);
    return false;
  }
}

/**
 * Close multiple Terminal windows by their indices
 * Closes from highest index to lowest to avoid index shifting
 */
function closeWindows(indices) {
  // Sort descending so we close higher indices first
  const sorted = [...indices].sort((a, b) => b - a);
  const results = [];

  for (const index of sorted) {
    results.push({ index, closed: closeWindow(index) });
  }

  return results;
}

/**
 * Get summary stats about terminal windows
 */
function getStats() {
  const windows = listWindows();
  return {
    total: windows.length,
    protected: windows.filter(w => w.protected).length,
    closeable: windows.filter(w => !w.protected).length
  };
}

module.exports = {
  listWindows,
  focusWindow,
  closeWindow,
  closeWindows,
  getStats,
  PROTECTED_PATTERNS
};
