require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Constants ───────────────────────────────────────────────────────────────

const HOME = os.homedir();


const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const ARCHIVE_DIR = path.join(__dirname, "sessions", "archive");
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);

// ── Settings ─────────────────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(__dirname, "settings.json");

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); }
  catch (_) { return { autoApproval: { enabled: false, tools: {}, blockedPatterns: [] } }; }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ── Hook-based Permission System ─────────────────────────────────────────────
// When Claude Code fires a PermissionRequest hook, the request comes here.
// We check auto-approval settings; if "auto" → respond immediately.
// If "ask" → hold the request (long-poll) until user acts via dashboard.
// If "block" → respond immediately with deny.

const pendingHookPermissions = new Map(); // id → { resolve, data, timestamp }
let hookPermissionCounter = 0;

function createHookPermission(data) {
  const id = "hook-" + (++hookPermissionCounter) + "-" + Date.now();
  return new Promise((resolve) => {
    const entry = {
      id,
      resolve,
      data, // raw hook input: tool_name, tool_input, session_id, transcript_path, etc.
      timestamp: Date.now()
    };
    pendingHookPermissions.set(id, entry);

    // Timeout after 90 seconds — deny if user doesn't respond
    setTimeout(() => {
      if (pendingHookPermissions.has(id)) {
        pendingHookPermissions.delete(id);
        resolve({ behavior: "deny", message: "Permission request timed out (90s)" });
      }
    }, 90000);
  });
}

function resolveHookPermission(id, behavior) {
  const entry = pendingHookPermissions.get(id);
  if (!entry) return false;
  pendingHookPermissions.delete(id);
  if (behavior === "allow") {
    entry.resolve({ behavior: "allow" });
  } else {
    entry.resolve({ behavior: "deny", message: "Denied by operator" });
  }
  return true;
}

// Check if a tool should be auto-approved based on settings
function checkToolPolicy(toolName, toolInput) {
  const settings = loadSettings();
  const aa = settings.autoApproval;
  if (!aa || !aa.enabled) return "ask"; // Default to ask if auto-approval disabled

  const tier = aa.tools[toolName];
  if (!tier || tier === "ask") return "ask";
  if (tier === "block") return "block";

  // "auto" tier — check blocked patterns for Bash
  if (toolName === "Bash" && aa.blockedPatterns && aa.blockedPatterns.length > 0) {
    const input = typeof toolInput === "object" ? JSON.stringify(toolInput) : String(toolInput || "");
    for (const pattern of aa.blockedPatterns) {
      if (input.includes(pattern)) return "block";
    }
  }

  return "auto";
}

// Clean up expired hook permissions every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingHookPermissions) {
    if (now - entry.timestamp > 95000) {
      pendingHookPermissions.delete(id);
    }
  }
}, 30000);

// ── Claude Desktop ──────────────────────────────────────────────────────────
const CLAUDE_SESSIONS_DIR = path.join(HOME, ".claude", "projects");
const HELPER_APP = path.join(__dirname, "AgentBrainHelper.app", "Contents", "MacOS", "helper");


function decodeClaudeProjectDir(encoded) {
  // Claude Code encodes paths like: -Users-lukeblanton-agent-brain
  // where - is the path separator (/) but also appears in real names
  // Strategy: try progressively joining segments to find real paths
  const parts = encoded.replace(/^-/, "").split("-");
  let resolved = "/";
  for (let i = 0; i < parts.length; i++) {
    // Try adding just this segment
    const tryPath = path.join(resolved, parts[i]);
    if (fs.existsSync(tryPath)) {
      resolved = tryPath;
    } else {
      // Try joining with the next segment(s) using dashes (it might be a hyphenated name)
      let found = false;
      let combined = parts[i];
      for (let j = i + 1; j < parts.length; j++) {
        combined += "-" + parts[j];
        const tryCombo = path.join(resolved, combined);
        if (fs.existsSync(tryCombo)) {
          resolved = tryCombo;
          i = j; // skip ahead
          found = true;
          break;
        }
      }
      if (!found) {
        // Can't resolve — just join remaining with dashes
        resolved = path.join(resolved, parts.slice(i).join("-"));
        break;
      }
    }
  }
  return resolved;
}

function listClaudeCodeSessions() {
  // Scan ~/.claude/projects/ for session JSONL files
  const results = [];
  try {
    const projectDirs = fs.readdirSync(CLAUDE_SESSIONS_DIR);
    for (const dir of projectDirs) {
      const dirPath = path.join(CLAUDE_SESSIONS_DIR, dir);
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue;
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith(".jsonl"));
      for (const f of files) {
        const sessionId = f.replace(".jsonl", "");
        const filePath = path.join(dirPath, f);
        const fileStat = fs.statSync(filePath);
        // Read only first ~50 lines to extract metadata efficiently
        let firstUserMsg = "";
        let slug = "";
        try {
          const fd = fs.openSync(filePath, "r");
          const buf = Buffer.alloc(32768); // 32KB should cover first messages
          const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          const chunk = buf.slice(0, bytesRead).toString("utf8");
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.slug && !slug) slug = obj.slug;
              if (obj.type === "user" && obj.message && obj.message.content && !firstUserMsg) {
                const txt = typeof obj.message.content === "string" ? obj.message.content : "";
                if (txt && !obj.toolUseResult) firstUserMsg = txt.slice(0, 80);
              }
              if (firstUserMsg && slug) break;
            } catch (_) {}
          }
        } catch (_) {}
        // Decode project path
        let projectPath = decodeClaudeProjectDir(dir);
        let title = firstUserMsg || path.basename(projectPath);
        results.push({
          session_id: sessionId,
          project_dir: dir,
          project_path: projectPath,
          slug: slug,
          title: title.length > 55 ? title.slice(0, 52) + "..." : title,
          updated_at: fileStat.mtime.toISOString(),
          source: "claude-code"
        });
      }
    }
  } catch (_) {}
  // Sort by most recent
  results.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  return results.slice(0, 50); // Cap at 50
}

function readClaudeCodeSession(projectDir, sessionId) {
  const filePath = path.join(CLAUDE_SESSIONS_DIR, projectDir, sessionId + ".jsonl");
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.trim().split("\n");
  const messages = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === "user" && obj.message) {
        const txt = typeof obj.message.content === "string" ? obj.message.content : "";
        if (txt && !obj.toolUseResult) {
          messages.push({ role: "user", content: txt });
        }
      } else if (obj.type === "assistant" && obj.message) {
        const contentBlocks = obj.message.content || [];
        let text = "";
        const toolCalls = [];
        for (const block of contentBlocks) {
          if (block.type === "text") text += block.text;
          else if (block.type === "tool_use") {
            toolCalls.push({ name: block.name, input: JSON.stringify(block.input || {}).slice(0, 500) });
          }
        }
        if (toolCalls.length > 0) {
          messages.push({ role: "tool_use", tools: toolCalls });
        }
        if (text.trim()) {
          messages.push({ role: "assistant", content: text });
        }
      } else if (obj.type === "user" && obj.toolUseResult) {
        // Tool result — skip for display (too noisy)
      }
    } catch (_) {}
  }
  return messages;
}

// ── Claude Desktop keystroke injection ──────────────────────────────────────

function injectIntoClaudeDesktop(message) {
  return new Promise((resolve, reject) => {
    // Native Swift binary handles: activate Claude, clipboard paste, Enter key
    // The binary IS the .app bundle executable, so macOS Accessibility permission
    // applies to AgentBrainHelper.app (not osascript).
    execFile(HELPER_APP, [message], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve("Message injected into Claude Desktop");
    });
  });
}

// Check if a CC session has a pending permission prompt
function checkPendingPermission(projectDir, sessionId) {
  const filePath = path.join(CLAUDE_SESSIONS_DIR, projectDir, sessionId + ".jsonl");
  if (!fs.existsSync(filePath)) return null;

  const stat = fs.statSync(filePath);
  const ageMs = Date.now() - stat.mtimeMs;

  // Staleness cap: if JSONL not modified in 10+ minutes, the session is dead
  if (ageMs > 600000) return { pending: false };

  // Settlement check: if the file is being actively written to (< 3 seconds ago),
  // the tool might still be executing. Wait for writes to settle before detecting.
  // This prevents false positives for tools that are currently running.
  // The auto-approval poll runs every 3s, so we'll catch it on the next cycle.
  if (ageMs < 3000) return { pending: false };

  // Read last ~16KB to find the most recent entries (larger buffer for big tool inputs)
  const readSize = Math.min(stat.size, 16384);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
  fs.closeSync(fd);
  const tail = buf.toString("utf8");
  const lines = tail.split("\n").filter(l => l.trim());

  // Walk backwards through JSONL entries.
  // A permission is pending ONLY if:
  //   1. The most recent assistant content includes tool_use
  //   2. No tool_result or progress entries follow it
  // If we encounter a tool_result, progress entry, or assistant text before
  // finding a tool_use, the session has moved on — not pending.

  let foundToolUseIdx = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);

      // If we hit a tool_result (user entry with toolUseResult), tool already ran
      if (obj.type === "user" && obj.toolUseResult) {
        return { pending: false };
      }

      // If we hit a user entry with tool_result content blocks, tool already ran
      if (obj.type === "user" && obj.message && Array.isArray(obj.message.content)) {
        const hasToolResult = obj.message.content.some(c => c.type === "tool_result");
        if (hasToolResult) return { pending: false };
      }

      // If we hit a progress entry, a tool is currently executing (not waiting for permission)
      if (obj.type === "progress") {
        return { pending: false };
      }

      if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
        const tools = obj.message.content.filter(c => c.type === "tool_use");
        if (tools.length > 0) {
          foundToolUseIdx = i;
          break;
        }
        // Assistant entry with text but no tool_use — session has moved past tool phase
        const hasText = obj.message.content.some(c => c.type === "text" && c.text && c.text.trim());
        if (hasText) {
          return { pending: false };
        }
      }
    } catch (_) {}
  }

  if (foundToolUseIdx === -1) {
    return { pending: false };
  }

  // Found a tool_use — extract tool info
  try {
    const obj = JSON.parse(lines[foundToolUseIdx]);
    const tools = obj.message.content
      .filter(c => c.type === "tool_use")
      .map(t => ({ name: t.name, input: JSON.stringify(t.input || {}).slice(0, 300) }));
    return { pending: true, tools };
  } catch (_) {}

  return { pending: false };
}

// Get full session state: needs_attention / active / idle
function getSessionState(projectDir, sessionId) {
  const filePath = path.join(CLAUDE_SESSIONS_DIR, projectDir, sessionId + ".jsonl");
  if (!fs.existsSync(filePath)) return { status: "idle", permission: null, current_tool: null, last_activity: null };

  const stat = fs.statSync(filePath);
  const lastActivity = stat.mtime.toISOString();
  const ageMs = Date.now() - stat.mtimeMs;

  // Check for pending permission first
  const perm = checkPendingPermission(projectDir, sessionId);
  if (perm && perm.pending) {
    return { status: "needs_attention", permission: perm, current_tool: null, last_activity: lastActivity };
  }

  // Active if JSONL modified in last 2 minutes
  if (ageMs < 120000) {
    let currentTool = null;
    try {
      const readSize = Math.min(stat.size, 4096);
      const buf = Buffer.alloc(readSize);
      const fd = fs.openSync(filePath, "r");
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      const lines = buf.toString("utf8").split("\n").filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
            const tools = obj.message.content.filter(c => c.type === "tool_use");
            if (tools.length > 0) {
              currentTool = tools[tools.length - 1].name;
              break;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
    return { status: "active", permission: null, current_tool: currentTool, last_activity: lastActivity };
  }

  return { status: "idle", permission: null, current_tool: null, last_activity: lastActivity };
}

// Send a keystroke to Claude Desktop (Enter to approve, Escape to deny)
// Note: keystroke goes to the CURRENTLY FOCUSED session in Desktop.
function sendKeystrokeToClaude(keyCode) {
  return new Promise((resolve, reject) => {
    // key code 36 = Enter/Return, key code 53 = Escape
    const script = `
tell application "Claude" to activate
delay 0.5
tell application "System Events"
  tell process "Claude"
    set frontmost to true
    delay 0.3
    key code ${keyCode}
  end tell
end tell
`;
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve("OK");
    });
  });
}

// ── Utilities ────────────────────────────────────────────────────────────────

function nowId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    "-" +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// ── Session management ───────────────────────────────────────────────────────

function createSession() {
  const session_id = nowId();
  const session = {
    session_id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "",
    provider: "claude-code",
    claude_session_id: null,
    cc_project_dir: null,
    messages: []
  };
  saveSession(session);
  return session;
}

function saveSession(session) {
  session.updated_at = new Date().toISOString();
  const p = path.join(SESSIONS_DIR, `${session.session_id}.json`);
  fs.writeFileSync(p, JSON.stringify(session, null, 2));
}

function loadSession(session_id) {
  const p = path.join(SESSIONS_DIR, `${session_id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json") && f !== "folders.json").sort().reverse();
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
    return {
      session_id: data.session_id,
      title: data.title || "(untitled)",
      created_at: data.created_at,
      updated_at: data.updated_at,
      claude_session_id: data.claude_session_id || null
    };
  });
}

function autoTitle(session) {
  if (session.title) return;
  const firstUser = session.messages.find(m => m.role === "user");
  if (firstUser) {
    let t = firstUser.content.trim();
    if (t.length > 50) t = t.slice(0, 47) + "...";
    session.title = t;
  }
}

// ── Folder management ─────────────────────────────────────────────────────

const FOLDERS_FILE = path.join(SESSIONS_DIR, "folders.json");

function loadFolders() {
  if (!fs.existsSync(FOLDERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(FOLDERS_FILE, "utf8")); } catch (_) { return []; }
}

function saveFolders(folders) {
  fs.writeFileSync(FOLDERS_FILE, JSON.stringify(folders, null, 2));
}

function createFolder(name) {
  const folders = loadFolders();
  const id = "f_" + Date.now();
  folders.push({ id, name, session_ids: [] });
  saveFolders(folders);
  return folders;
}

function moveToFolder(sessionId, folderId) {
  const folders = loadFolders();
  // Remove from any existing folder first
  for (const f of folders) {
    f.session_ids = f.session_ids.filter(s => s !== sessionId);
  }
  if (folderId) {
    const folder = folders.find(f => f.id === folderId);
    if (folder) folder.session_ids.push(sessionId);
  }
  saveFolders(folders);
  return folders;
}

// ── API routes ───────────────────────────────────────────────────────────────

app.get("/api/sessions", (_req, res) => {
  res.json(listSessions());
});

app.get("/api/sessions/:id", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // If this is a linked CC session, read messages live from JSONL
  if (session.cc_project_dir && session.claude_session_id) {
    const liveMessages = readClaudeCodeSession(session.cc_project_dir, session.claude_session_id);
    if (liveMessages) session.messages = liveMessages;
  }

  res.json(session);
});

// Create a new Claude Desktop conversation and link it
app.post("/chat/new", async (req, res) => {
  const firstMessage = (req.body.message || "").trim();
  if (!firstMessage) return res.status(400).json({ error: "First message required" });

  // Create Agent Brain session
  const session = createSession();

  try {
    // Snapshot existing JSONL files so we can detect the new one
    const existingFiles = new Set();
    try {
      for (const dir of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
        const dirPath = path.join(CLAUDE_SESSIONS_DIR, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        for (const f of fs.readdirSync(dirPath)) {
          if (f.endsWith(".jsonl")) existingFiles.add(dir + "/" + f);
        }
      }
    } catch (_) {}

    // Open Claude Desktop in Code mode — don't use Cmd+N (that opens Chat)
    // Just navigate to Code view and inject directly into its input
    await new Promise((resolve, reject) => {
      execFile("/usr/bin/open", ["claude://claude.ai/claude-code-desktop"], { timeout: 5000 }, (err) => {
        if (err) return reject(err);
        // Wait for Code mode to fully load
        setTimeout(resolve, 2500);
      });
    });

    // Inject the first message directly into the Code input
    await injectIntoClaudeDesktop(firstMessage);

    // Auto-title from first message
    session.title = firstMessage.length > 50 ? firstMessage.slice(0, 47) + "..." : firstMessage;
    saveSession(session);

    // Watch for the new JSONL to appear (poll for up to 30 seconds)
    let linked = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        for (const dir of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
          const dirPath = path.join(CLAUDE_SESSIONS_DIR, dir);
          if (!fs.statSync(dirPath).isDirectory()) continue;
          for (const f of fs.readdirSync(dirPath)) {
            if (!f.endsWith(".jsonl")) continue;
            const key = dir + "/" + f;
            if (existingFiles.has(key)) continue;
            // New JSONL found — check if it's recent (within last 20 seconds)
            const stat = fs.statSync(path.join(dirPath, f));
            if (Date.now() - stat.mtimeMs < 20000) {
              session.cc_project_dir = dir;
              session.claude_session_id = f.replace(".jsonl", "");
              saveSession(session);
              linked = true;
              break;
            }
          }
          if (linked) break;
        }
      } catch (_) {}
      if (linked) break;
    }

    res.json({ session_id: session.session_id, linked });
  } catch (e) {
    // Still return the session even if linking fails
    saveSession(session);
    res.json({ session_id: session.session_id, linked: false, error: e.message });
  }
});

app.patch("/api/sessions/:id", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (req.body.title !== undefined) session.title = req.body.title;
  saveSession(session);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/archive", (req, res) => {
  const src = path.join(SESSIONS_DIR, `${req.params.id}.json`);
  const dst = path.join(ARCHIVE_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(src)) return res.status(404).json({ error: "Session not found" });
  fs.renameSync(src, dst);
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", (req, res) => {
  const p = path.join(SESSIONS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "Session not found" });
  fs.unlinkSync(p);
  res.json({ ok: true });
});

// ── Folder API routes ──────────────────────────────────────────────────────

app.get("/api/folders", (_req, res) => {
  res.json(loadFolders());
});

app.post("/api/folders", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  const folders = createFolder(name);
  res.json(folders);
});

app.patch("/api/folders/:id", (req, res) => {
  const folders = loadFolders();
  const folder = folders.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: "Folder not found" });
  if (req.body.name !== undefined) folder.name = req.body.name;
  saveFolders(folders);
  res.json(folders);
});

app.delete("/api/folders/:id", (req, res) => {
  let folders = loadFolders();
  folders = folders.filter(f => f.id !== req.params.id);
  saveFolders(folders);
  res.json(folders);
});

app.post("/api/sessions/:id/move", (req, res) => {
  const folderId = req.body.folder_id || null; // null = remove from folder
  const folders = moveToFolder(req.params.id, folderId);
  res.json(folders);
});

// All sessions are Claude Desktop — sending a message means injecting via keystroke
app.post("/api/sessions/:id/message", async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "No message content" });

  try {
    // Inject into whichever session is currently focused in Claude Desktop
    await injectIntoClaudeDesktop(content);
    res.json({ ok: true });
  } catch (e) {
    const hint = e.message.includes("not allowed") || e.message.includes("accessibility") || e.message.includes("1002") || e.message.includes("not permitted") || e.message.includes("not trusted")
      ? " — Grant Accessibility to AgentBrainHelper: System Settings → Privacy & Security → Accessibility"
      : (e.message.includes("not running") ? " — Make sure Claude Desktop is open on your Mac" : "");
    res.json({ error: e.message + hint });
  }
});

// ── Claude Code session browsing ──────────────────────────────────────────

app.get("/api/claude-sessions", (_req, res) => {
  res.json(listClaudeCodeSessions());
});

app.get("/api/claude-sessions/:projectDir/:sessionId", (req, res) => {
  const messages = readClaudeCodeSession(req.params.projectDir, req.params.sessionId);
  if (!messages) return res.status(404).json({ error: "Session not found" });
  res.json({
    session_id: req.params.sessionId,
    project_dir: req.params.projectDir,
    messages,
    source: "claude-code"
  });
});

// Direct CC session permission check (for unlinked sessions)
app.get("/api/claude-sessions/:projectDir/:sessionId/pending-permission", (req, res) => {
  const result = checkPendingPermission(req.params.projectDir, req.params.sessionId);
  res.json(result || { pending: false });
});

// Resume a Claude Code session into Agent Brain
app.post("/api/claude-sessions/:projectDir/:sessionId/adopt", (req, res) => {
  const { projectDir, sessionId } = req.params;

  // Check if an Agent Brain session already exists for this CC session
  const existing = listSessions().find(s => {
    const full = loadSession(s.session_id);
    return full && full.claude_session_id === sessionId && full.cc_project_dir === projectDir;
  });
  if (existing) {
    return res.json({ session_id: existing.session_id });
  }

  // Verify the CC session exists
  const messages = readClaudeCodeSession(projectDir, sessionId);
  if (!messages) return res.status(404).json({ error: "Session not found" });

  // Create a new Agent Brain session linked to this CC session (read-through, no message copy)
  const session = createSession();
  session.claude_session_id = sessionId;
  session.cc_project_dir = projectDir;
  session.messages = []; // messages are read live from JSONL
  // Use first user message as title
  const firstUser = messages.find(m => m.role === "user");
  if (firstUser) {
    let t = firstUser.content.trim();
    if (t.length > 50) t = t.slice(0, 47) + "...";
    session.title = t;
  }
  saveSession(session);
  res.json({ session_id: session.session_id });
});

// ── Permission prompt detection & approval ────────────────────────────────────

// Test permission overrides — fake permissions for testing the permission bar
const testPermissionOverrides = new Map(); // sessionId → { tools, expires }

app.get("/api/sessions/:id/pending-permission", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Check test overrides first
  const override = testPermissionOverrides.get(req.params.id);
  if (override && Date.now() < override.expires) {
    return res.json({ pending: true, tools: override.tools });
  }
  if (override) testPermissionOverrides.delete(req.params.id);

  if (!session.cc_project_dir || !session.claude_session_id) {
    return res.json({ pending: false });
  }
  const result = checkPendingPermission(session.cc_project_dir, session.claude_session_id);
  res.json(result || { pending: false });
});

app.post("/api/sessions/:id/approve", async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Clear any test permission override
  const wasTest = testPermissionOverrides.has(req.params.id);
  testPermissionOverrides.delete(req.params.id);

  // If this was a test override, don't send real keystrokes
  if (wasTest) {
    return res.json({ ok: true, test: true });
  }

  const action = req.body.action || "approve"; // "approve" or "deny"
  try {
    // Send keystroke to the currently focused session in Claude Desktop
    // (Enter to approve, Escape to deny)
    const keyCode = action === "deny" ? 53 : 36;
    await sendKeystrokeToClaude(keyCode);
    res.json({ ok: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Test permission bar — sets a fake permission picked up by polling
app.post("/api/sessions/:id/test-permission", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  testPermissionOverrides.set(req.params.id, {
    tools: [
      { name: "Bash", input: '{"command":"echo hello world"}' },
      { name: "Read", input: '{"file_path":"/etc/hosts"}' }
    ],
    expires: Date.now() + 30000
  });

  res.json({ ok: true, expires_in: "30s" });
});

// Universal approve endpoint — sends keystroke regardless of session type
app.post("/api/approve", async (req, res) => {
  const action = req.body.action || "approve";
  try {
    const keyCode = action === "deny" ? 53 : 36;
    await sendKeystrokeToClaude(keyCode);
    res.json({ ok: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── Dashboard API ──────────────────────────────────────────────────────────

app.get("/api/dashboard", (_req, res) => {
  const sessions = listSessions();
  const results = [];
  const seenCC = new Map(); // "dir:claudeSessionId" → index in results

  // First: add all linked Agent Brain sessions
  for (const s of sessions) {
    const full = loadSession(s.session_id);
    if (!full) continue;

    let state = { status: "idle", permission: null, current_tool: null, last_activity: s.updated_at };

    // Check test overrides first
    const override = testPermissionOverrides.get(s.session_id);
    if (override && Date.now() < override.expires) {
      state = {
        status: "needs_attention",
        permission: { pending: true, tools: override.tools },
        current_tool: null,
        last_activity: new Date().toISOString()
      };
    } else if (full.cc_project_dir && full.claude_session_id) {
      state = getSessionState(full.cc_project_dir, full.claude_session_id);
    }

    const item = {
      session_id: s.session_id,
      title: s.title || "(untitled)",
      ...state,
      linked: !!(full.cc_project_dir && full.claude_session_id)
    };

    // Deduplicate: if two AB sessions link to the same CC session, keep the most recently updated
    if (full.cc_project_dir && full.claude_session_id) {
      const ccKey = full.cc_project_dir + ":" + full.claude_session_id;
      if (seenCC.has(ccKey)) {
        const idx = seenCC.get(ccKey);
        if (new Date(s.updated_at) > new Date(sessions.find(x => x.session_id === results[idx].session_id)?.updated_at || 0)) {
          results[idx] = item;
        }
        continue;
      }
      seenCC.set(ccKey, results.length);
    }

    results.push(item);
  }

  // Second: scan ALL CC sessions for active/needs_attention ones not already linked
  // This fulfills "No opt-in required — reads all local sessions automatically"
  try {
    const ccSessions = listClaudeCodeSessions();
    for (const cc of ccSessions) {
      const ccKey = cc.project_dir + ":" + cc.session_id;
      if (seenCC.has(ccKey)) continue; // Already shown via a linked AB session

      const state = getSessionState(cc.project_dir, cc.session_id);
      // Only include active or needs_attention CC sessions (skip idle ones to avoid clutter)
      if (state.status === "idle") continue;

      results.push({
        session_id: cc.project_dir + "/" + cc.session_id, // composite ID for unlinked sessions
        title: cc.title || path.basename(cc.project_path),
        ...state,
        linked: false,
        cc_project_dir: cc.project_dir,
        cc_session_id: cc.session_id
      });
      seenCC.set(ccKey, results.length - 1);
    }
  } catch (_) {}

  // Third: include hook-based pending permissions (from PermissionRequest hooks)
  // These are the most reliable — they come directly from Claude Code, not JSONL parsing
  const hookPending = [];
  for (const [id, entry] of pendingHookPermissions) {
    hookPending.push({
      id,
      session_id: "hook:" + id,
      title: entry.data.session_id ? `Session ${entry.data.session_id.slice(0, 8)}...` : "Claude Code",
      status: "needs_attention",
      permission: {
        pending: true,
        hook_id: id,
        tools: [{ name: entry.data.tool_name, input: entry.data.input_summary }]
      },
      current_tool: null,
      last_activity: new Date(entry.timestamp).toISOString(),
      linked: false,
      source: "hook"
    });
  }

  // Hook permissions go first (they are actively blocking Claude Code)
  res.json([...hookPending, ...results]);
});

// ── Hook-based Permission Endpoint ───────────────────────────────────────────
// Called by Claude Code's PermissionRequest hook (via command hook script → curl)
// Input: raw hook event JSON from Claude Code
// Output: hook response JSON with allow/deny decision

app.post("/api/hooks/permission-request", async (req, res) => {
  const hookInput = req.body;
  const toolName = hookInput.tool_name || hookInput.toolName || "Unknown";
  const toolInput = hookInput.tool_input || hookInput.toolInput || {};
  const sessionId = hookInput.session_id || hookInput.sessionId || "unknown";
  const transcriptPath = hookInput.transcript_path || hookInput.transcriptPath || "";

  // Extract a readable summary of what the tool wants to do
  let inputSummary = "";
  if (typeof toolInput === "object") {
    inputSummary = toolInput.command || toolInput.file_path || toolInput.pattern || toolInput.url || JSON.stringify(toolInput).slice(0, 300);
  } else {
    inputSummary = String(toolInput).slice(0, 300);
  }

  console.log(`[hook] PermissionRequest: ${toolName} in session ${sessionId.slice(0, 12)}... — ${inputSummary.slice(0, 80)}`);

  // Check auto-approval policy
  const policy = checkToolPolicy(toolName, toolInput);

  if (policy === "auto") {
    console.log(`[hook] Auto-approved: ${toolName}`);
    return res.json({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" }
      }
    });
  }

  if (policy === "block") {
    console.log(`[hook] Blocked: ${toolName}`);
    return res.json({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: `Tool "${toolName}" is blocked by Agent Brain policy`
        }
      }
    });
  }

  // "ask" policy — hold request and wait for user decision via dashboard
  console.log(`[hook] Awaiting manual approval: ${toolName}`);
  const decision = await createHookPermission({
    tool_name: toolName,
    tool_input: toolInput,
    input_summary: inputSummary,
    session_id: sessionId,
    transcript_path: transcriptPath,
    raw: hookInput
  });

  console.log(`[hook] Decision for ${toolName}: ${decision.behavior}`);
  res.json({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision
    }
  });
});

// Get list of pending hook permissions (for dashboard)
app.get("/api/hooks/pending", (_req, res) => {
  const pending = [];
  for (const [id, entry] of pendingHookPermissions) {
    pending.push({
      id,
      tool_name: entry.data.tool_name,
      tool_input: entry.data.tool_input,
      input_summary: entry.data.input_summary,
      session_id: entry.data.session_id,
      timestamp: entry.timestamp,
      age_seconds: Math.floor((Date.now() - entry.timestamp) / 1000)
    });
  }
  res.json(pending);
});

// Resolve a pending hook permission (from dashboard Allow/Deny button)
app.post("/api/hooks/pending/:id/resolve", (req, res) => {
  const { id } = req.params;
  const behavior = req.body.behavior || "deny"; // "allow" or "deny"
  const ok = resolveHookPermission(id, behavior);
  if (!ok) return res.status(404).json({ error: "Permission request not found or already resolved" });
  res.json({ ok: true, behavior });
});

// ── Settings API ─────────────────────────────────────────────────────────────

app.get("/api/settings", (_req, res) => {
  res.json(loadSettings());
});

app.put("/api/settings", (req, res) => {
  const settings = req.body;
  saveSettings(settings);
  res.json({ ok: true });
});

// ── Auto-approval engine ─────────────────────────────────────────────────────

// Track recently auto-approved sessions to avoid double-firing
const autoApprovedRecently = new Map(); // "projectDir:sessionId" → timestamp

function shouldAutoApprove(tools) {
  const settings = loadSettings();
  const aa = settings.autoApproval;
  if (!aa || !aa.enabled) return false;

  for (const tool of tools) {
    const tier = aa.tools[tool.name];

    // Unknown tool or "ask" tier → require manual approval
    if (!tier || tier === "ask") return false;

    // "block" tier → never approve
    if (tier === "block") return false;

    // "auto" tier — but check blocked patterns for Bash commands
    if (tool.name === "Bash" && aa.blockedPatterns && aa.blockedPatterns.length > 0) {
      const input = tool.input || "";
      for (const pattern of aa.blockedPatterns) {
        if (input.includes(pattern)) return false;
      }
    }
  }

  return true; // All tools in this request are "auto" tier
}

// Legacy JSONL-based auto-approval (keystroke fallback)
// Now largely superseded by PermissionRequest hooks, which handle permissions
// at the Claude Code level before the JSONL is even written.
// Keeping as a fallback for sessions where hooks aren't configured.
function runAutoApprovalCheck() {
  const ccSessions = listClaudeCodeSessions();

  for (const cc of ccSessions) {
    const perm = checkPendingPermission(cc.project_dir, cc.session_id);
    if (!perm || !perm.pending) continue;

    const key = cc.project_dir + ":" + cc.session_id;
    const last = autoApprovedRecently.get(key);
    if (last && Date.now() - last < 30000) continue; // 30s cooldown (longer since hooks handle most cases)

    if (shouldAutoApprove(perm.tools)) {
      console.log(`[keystroke-fallback] Approving ${perm.tools.map(t => t.name).join(", ")} in ${cc.title || cc.session_id}`);
      autoApprovedRecently.set(key, Date.now());
      sendKeystrokeToClaude(36).catch(e => {
        console.error("[keystroke-fallback] Failed:", e.message);
      });
      return;
    }
  }
}

// Run keystroke fallback every 10 seconds (slower since hooks are primary)
setInterval(runAutoApprovalCheck, 10000);

// Clean up old cooldown entries every minute
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of autoApprovedRecently) {
    if (now - ts > 60000) autoApprovedRecently.delete(key);
  }
}, 60000);

// ── HTML templates ───────────────────────────────────────────────────────────

const HOME_HTML = fs.readFileSync(path.join(__dirname, "views", "home.html"), "utf8");
const CHAT_HTML = fs.readFileSync(path.join(__dirname, "views", "chat.html"), "utf8");
const DASHBOARD_HTML = fs.readFileSync(path.join(__dirname, "views", "dashboard.html"), "utf8");
const SETTINGS_HTML = fs.readFileSync(path.join(__dirname, "views", "settings.html"), "utf8");

// ── UI routes ────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.type("html").send(DASHBOARD_HTML));
app.get("/settings", (_req, res) => res.type("html").send(SETTINGS_HTML));

app.get("/chat", (_req, res) => {
  res.type("html").send(HOME_HTML);
});

app.get("/chat/:session_id", (req, res) => {
  const html = CHAT_HTML.replace("{{SESSION_ID}}", req.params.session_id);
  res.type("html").send(html);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

// ── Cross-session notification polling (disabled — revisit with push notifications) ──
// Keeping the code for later. macOS `display notification` works on Mac but
// doesn't forward to iPhone. Need ntfy.sh or similar for phone push.

// ── Server startup ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3030;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent Brain running on http://localhost:${PORT}`);
});
