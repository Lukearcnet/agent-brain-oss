require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const db = require("./lib/db");
const app = express();
app.use(express.json({ limit: "2mb" }));

// Serve static files (PWA manifest, service worker, icons)
app.use(express.static(path.join(__dirname, "public")));

// ── Constants ───────────────────────────────────────────────────────────────

const HOME = os.homedir();


const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const ARCHIVE_DIR = path.join(__dirname, "sessions", "archive");
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);

// ── Settings ─────────────────────────────────────────────────────────────────
// Settings are stored in Supabase with an in-memory cache.
// Synchronous callers use db.getCachedSettings(); async callers use db.loadSettings().

function loadSettings() {
  return db.getCachedSettings();
}

async function loadSettingsAsync() {
  return db.loadSettings();
}

async function saveSettings(settings) {
  await db.saveSettings(settings);
}

// ── Event Log ────────────────────────────────────────────────────────────────
// Events stored in Supabase. logEvent is fire-and-forget (async, non-blocking).

function logEvent(type, sessionId, data = {}) {
  const event = { ts: new Date().toISOString(), type, session_id: sessionId || null, data };
  db.logEvent(type, sessionId, data).catch(e => console.error("[db] logEvent:", e.message));
  return event;
}

async function queryEvents(opts) {
  return db.queryEvents(opts);
}

// ── Project Name Mapping & Auto-Naming ──────────────────────────────────────
// Maps CC project directory keys to friendly project names for auto-naming.
// When a new session is first seen, it gets named "Project-Name #N".

const PROJECT_NAMES = {
  "-Users-lukeblanton-agent-brain": "Agent Brain",
  "-Users-lukeblanton-Documents-TCC-Project-Insiders-MVP": "Insiders MVP",
  "-Users-lukeblanton-Documents-arc-ios-local": "Arc Social",
  // Worktrees map to same project
  "-Users-lukeblanton--claude-worktrees-arc-ios-local-dreamy-sanderson": "Arc Social",
  "-Users-lukeblanton--claude-worktrees-arc-ios-local-exciting-blackburn": "Arc Social",
  "-Users-lukeblanton--claude-worktrees-arc-ios-local-unruffled-kapitsa": "Arc Social",
};

function getProjectName(projectDir) {
  if (PROJECT_NAMES[projectDir]) return PROJECT_NAMES[projectDir];
  // Fallback: use last path segment, prettified
  const parts = projectDir.replace(/^-/, "").split("-");
  const last = parts[parts.length - 1];
  return last.charAt(0).toUpperCase() + last.slice(1);
}

async function getNextSessionNumber(projectName) {
  // Count existing sessions with this project name prefix
  const sessions = await listSessions();
  let maxNum = 0;
  const pattern = new RegExp("^" + projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(\\d+)?$", "i");
  for (const s of sessions) {
    const match = (s.title || "").match(pattern);
    if (match) {
      const num = parseInt(match[1] || "1", 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return maxNum + 1;
}

async function autoNameSession(session) {
  if (session.title && session.title.trim()) return; // already named
  if (!session.cc_project_dir) return;
  const projectName = getProjectName(session.cc_project_dir);
  const num = await getNextSessionNumber(projectName);
  session.title = projectName + " " + num;
}

// ── Project Memory System ────────────────────────────────────────────────────
// Per-project persistent memory stored in Supabase tables:
// project_memory, daily_logs, memory_topics

// ── Inter-Session Mailbox ────────────────────────────────────────────────────
// Mailbox stored in Supabase. All functions are async.

async function sendMailboxMessage(opts) {
  return db.sendMailboxMessage(opts);
}

async function readMailbox(sessionId, opts) {
  return db.readMailbox(sessionId, opts);
}

async function markMailboxRead(messageId) {
  return db.markMailboxRead(messageId);
}

async function getUnreadCount(sessionId) {
  return db.getUnreadCount(sessionId);
}

// ── Hook-based Permission System ─────────────────────────────────────────────
// When Claude Code fires a PermissionRequest hook, the request comes here.
// We check auto-approval settings; if "auto" → respond immediately.
// If "ask" → hold the request (long-poll) until user acts via dashboard.
// If "block" → respond immediately with deny.

const pendingHookPermissions = new Map(); // id → { resolve, data, timestamp }
const recentlyResolvedSessions = new Map(); // CC session UUID → timestamp (suppress JSONL re-detection)
let hookPermissionCounter = 0;

function createHookPermission(data, preId) {
  const id = preId || ("hook-" + (++hookPermissionCounter) + "-" + Date.now());
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
        logEvent("permission_timeout", entry.data.session_id, { hook_id: id, tool: entry.data.tool_name });
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
  // Track this CC session as recently resolved so JSONL detection doesn't re-surface it
  const ccSessionId = entry.data.session_id;
  if (ccSessionId && ccSessionId !== "unknown") {
    recentlyResolvedSessions.set(ccSessionId, Date.now());
  }
  logEvent("permission_resolved", ccSessionId, {
    hook_id: id,
    tool: entry.data.tool_name,
    decision: behavior,
    source: "dashboard"
  });
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

// ── Push Notifications (ntfy.sh) ─────────────────────────────────────────────

async function sendPushNotification({ title, message, priority, hookId }) {
  const settings = loadSettings();
  const notif = settings.notifications;
  if (!notif || !notif.enabled || !notif.ntfyTopic) return;

  const server = notif.ntfyServer || "https://ntfy.sh";
  const url = `${server}/${notif.ntfyTopic}`;

  const headers = {
    "Title": title || "Agent Brain",
    "Priority": String(priority || 4),
    "Tags": "robot",
  };

  // If we have a callback URL and hook ID, add Allow/Deny action buttons
  if (notif.agentBrainUrl && hookId) {
    const base = notif.agentBrainUrl.replace(/\/$/, "");
    const allowUrl = `${base}/api/hooks/pending/${encodeURIComponent(hookId)}/resolve`;
    const denyUrl = allowUrl;
    headers["Actions"] = [
      `http, Allow, ${allowUrl}, method=POST, headers.Content-Type=application/json, body={"behavior":"allow"}`,
      `http, Deny, ${denyUrl}, method=POST, headers.Content-Type=application/json, body={"behavior":"deny"}`
    ].join("; ");

    // Click opens dashboard
    headers["Click"] = `${base}/`;
  }

  try {
    const https = require(server.startsWith("https") ? "https" : "http");
    const { URL } = require("url");
    const parsed = new URL(url);

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(message || "")
      }
    };

    await new Promise((resolve, reject) => {
      const req = https.request(reqOptions, (res) => {
        res.resume();
        res.on("end", resolve);
      });
      req.on("error", (e) => {
        console.error("[ntfy] Push notification failed:", e.message);
        resolve(); // Don't block on notification failure
      });
      req.write(message || "");
      req.end();
    });
    console.log("[ntfy] Notification sent:", title);
  } catch (e) {
    console.error("[ntfy] Push notification error:", e.message);
  }
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

async function createSession() {
  const session_id = nowId();
  return db.createSession(session_id);
}

async function saveSession(session) {
  await db.saveSession(session);
}

async function loadSession(session_id) {
  return db.loadSession(session_id);
}

async function listSessions() {
  return db.listSessions();
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

async function loadFolders() {
  return db.loadFolders();
}

async function createFolder(name) {
  return db.createFolder(name);
}

async function moveToFolder(sessionId, folderId) {
  return db.moveToFolder(sessionId, folderId);
}

// ── API routes ───────────────────────────────────────────────────────────────

app.get("/api/sessions", async (_req, res) => {
  res.json(await listSessions());
});

app.get("/api/sessions/:id", async (req, res) => {
  const session = await loadSession(req.params.id);
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
  const session = await createSession();

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
    await saveSession(session);

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
              await saveSession(session);
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
    await saveSession(session);
    res.json({ session_id: session.session_id, linked: false, error: e.message });
  }
});

app.patch("/api/sessions/:id", async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (req.body.title !== undefined) session.title = req.body.title;
  await saveSession(session);
  res.json({ ok: true });
});

app.post("/api/sessions/:id/archive", async (req, res) => {
  await db.archiveSession(req.params.id);
  logEvent("session_archived", req.params.id, {});
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", async (req, res) => {
  await db.deleteSession(req.params.id);
  logEvent("session_deleted", req.params.id, {});
  res.json({ ok: true });
});

// ── Folder API routes ──────────────────────────────────────────────────────

app.get("/api/folders", async (_req, res) => {
  res.json(await loadFolders());
});

app.post("/api/folders", async (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Name required" });
  const folders = await createFolder(name);
  res.json(folders);
});

app.patch("/api/folders/:id", async (req, res) => {
  // Rename folder directly in Supabase
  if (req.body.name !== undefined) {
    await db.supabase.from("folders").update({ name: req.body.name }).eq("id", req.params.id);
  }
  res.json(await loadFolders());
});

app.delete("/api/folders/:id", async (req, res) => {
  await db.deleteFolder(req.params.id);
  res.json(await loadFolders());
});

app.post("/api/sessions/:id/move", async (req, res) => {
  const folderId = req.body.folder_id || null; // null = remove from folder
  const folders = await moveToFolder(req.params.id, folderId);
  res.json(folders);
});

// All sessions are Claude Desktop — sending a message means injecting via keystroke
app.post("/api/sessions/:id/message", async (req, res) => {
  const session = await loadSession(req.params.id);
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
app.post("/api/claude-sessions/:projectDir/:sessionId/adopt", async (req, res) => {
  const { projectDir, sessionId } = req.params;

  // Check if an Agent Brain session already exists for this CC session
  const sessions = await listSessions();
  let existingId = null;
  for (const s of sessions) {
    const full = await loadSession(s.session_id);
    if (full && full.claude_session_id === sessionId && full.cc_project_dir === projectDir) {
      existingId = s.session_id;
      break;
    }
  }
  if (existingId) {
    return res.json({ session_id: existingId });
  }

  // Verify the CC session exists
  const messages = readClaudeCodeSession(projectDir, sessionId);
  if (!messages) return res.status(404).json({ error: "Session not found" });

  // Create a new Agent Brain session linked to this CC session (read-through, no message copy)
  const session = await createSession();
  session.claude_session_id = sessionId;
  session.cc_project_dir = projectDir;
  session.messages = []; // messages are read live from JSONL
  // Auto-name: "Project-Name #N"
  await autoNameSession(session);
  await saveSession(session);
  res.json({ session_id: session.session_id });
});

// ── Permission prompt detection & approval ────────────────────────────────────

// Test permission overrides — fake permissions for testing the permission bar
const testPermissionOverrides = new Map(); // sessionId → { tools, expires }

app.get("/api/sessions/:id/pending-permission", async (req, res) => {
  const session = await loadSession(req.params.id);
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
  const session = await loadSession(req.params.id);
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
app.post("/api/sessions/:id/test-permission", async (req, res) => {
  const session = await loadSession(req.params.id);
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

app.get("/api/dashboard", async (_req, res) => {
  const sessions = await listSessions();
  const results = [];
  const seenCC = new Map(); // "dir:claudeSessionId" → index in results

  // Build a lookup of active hook permissions by CC session ID
  // so we can merge them with named AB sessions instead of showing duplicates
  const hooksBySessionId = new Map(); // CC session UUID → [{ hookId, entry }]
  for (const [id, entry] of pendingHookPermissions) {
    const ccSessionId = entry.data.session_id;
    if (ccSessionId && ccSessionId !== "unknown") {
      if (!hooksBySessionId.has(ccSessionId)) hooksBySessionId.set(ccSessionId, []);
      hooksBySessionId.get(ccSessionId).push({ hookId: id, entry });
    }
  }
  const claimedHookIds = new Set(); // track which hooks got merged into a named session

  // First: add all linked Agent Brain sessions
  for (const s of sessions) {
    const full = await loadSession(s.session_id);
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
      // Check if there's a hook pending for this CC session — if so, use that
      // instead of JSONL detection (hook is the source of truth)
      const hooks = hooksBySessionId.get(full.claude_session_id);
      if (hooks && hooks.length > 0) {
        const h = hooks[0]; // use first pending hook for this session
        claimedHookIds.add(h.hookId);
        state = {
          status: "needs_attention",
          permission: {
            pending: true,
            hook_id: h.hookId,
            tools: [{ name: h.entry.data.tool_name, input: h.entry.data.input_summary }]
          },
          current_tool: null,
          last_activity: new Date(h.entry.timestamp).toISOString()
        };
      } else {
        state = getSessionState(full.cc_project_dir, full.claude_session_id);
        // Suppress JSONL "needs_attention" for sessions we just resolved via hook
        // (JSONL lags behind — Claude Code hasn't written a new line yet)
        const resolvedAt = recentlyResolvedSessions.get(full.claude_session_id);
        if (state.status === "needs_attention" && resolvedAt && (Date.now() - resolvedAt) < 15000) {
          state = { status: "active", permission: null, current_tool: null, last_activity: state.last_activity };
        }
      }
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

      // Check if there's a hook pending for this unlinked CC session
      const hooks = hooksBySessionId.get(cc.session_id);
      let state;
      if (hooks && hooks.length > 0) {
        const h = hooks[0];
        claimedHookIds.add(h.hookId);
        state = {
          status: "needs_attention",
          permission: {
            pending: true,
            hook_id: h.hookId,
            tools: [{ name: h.entry.data.tool_name, input: h.entry.data.input_summary }]
          },
          current_tool: null,
          last_activity: new Date(h.entry.timestamp).toISOString()
        };
      } else {
        state = getSessionState(cc.project_dir, cc.session_id);
        // Suppress JSONL "needs_attention" for sessions we just resolved via hook
        const resolvedAt = recentlyResolvedSessions.get(cc.session_id);
        if (state.status === "needs_attention" && resolvedAt && (Date.now() - resolvedAt) < 15000) {
          state = { status: "active", permission: null, current_tool: null, last_activity: state.last_activity };
        }
        // Only include active or needs_attention CC sessions (skip idle ones to avoid clutter)
        if (state.status === "idle") continue;
      }

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

  // Third: include any orphaned hook permissions that couldn't be matched to a session
  // (e.g., if the session_id from the hook doesn't match any known session)
  const hookPending = [];
  for (const [id, entry] of pendingHookPermissions) {
    if (claimedHookIds.has(id)) continue; // already merged into a named session above
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

  // Orphaned hook permissions go first (they are actively blocking Claude Code)
  // Then sort results: needs_attention first, then active, then idle
  results.sort((a, b) => {
    const order = { needs_attention: 0, active: 1, idle: 2 };
    return (order[a.status] || 2) - (order[b.status] || 2);
  });
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

  // Derive project directory from transcript path (e.g., /Users/lukeblanton/.claude/projects/-Users-lukeblanton-agent-brain/<uuid>.jsonl)
  let projectDir = "";
  if (transcriptPath) {
    const match = transcriptPath.match(/\/\.claude\/projects\/([^/]+)\//);
    if (match) projectDir = match[1];
  }

  // Auto-adopt: if we don't have a linked Agent Brain session for this CC session, create one
  if (sessionId && sessionId !== "unknown" && projectDir) {
    const allSessions = await listSessions();
    let found = false;
    for (const s of allSessions) {
      const full = await loadSession(s.session_id);
      if (full && full.claude_session_id === sessionId && full.cc_project_dir === projectDir) { found = true; break; }
    }
    if (!found) {
      const newSession = await createSession();
      newSession.claude_session_id = sessionId;
      newSession.cc_project_dir = projectDir;
      newSession.messages = [];
      await autoNameSession(newSession);
      await saveSession(newSession);
      console.log(`[hook] Auto-adopted CC session ${sessionId.slice(0, 12)}... as "${newSession.title}" (${newSession.session_id})`);
      logEvent("session_adopted", newSession.session_id, { cc_session_id: sessionId, project_dir: projectDir, title: newSession.title });
    }
  }

  console.log(`[hook] PermissionRequest: ${toolName} in session ${sessionId.slice(0, 12)}... — ${inputSummary.slice(0, 80)}`);

  // Check auto-approval policy
  const policy = checkToolPolicy(toolName, toolInput);

  if (policy === "auto") {
    console.log(`[hook] Auto-approved: ${toolName}`);
    logEvent("permission_resolved", sessionId, { tool: toolName, decision: "allow", source: "auto" });
    return res.json({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" }
      }
    });
  }

  if (policy === "block") {
    console.log(`[hook] Blocked: ${toolName}`);
    logEvent("permission_resolved", sessionId, { tool: toolName, decision: "deny", source: "blocked_pattern" });
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

  // Create the hook permission first so we have the ID for the notification
  const hookId = "hook-" + (++hookPermissionCounter) + "-" + Date.now();

  // Send push notification with Allow/Deny action buttons
  sendPushNotification({
    title: `Approve ${toolName}?`,
    message: inputSummary.slice(0, 200),
    priority: 4,
    hookId
  });

  const decision = await createHookPermission({
    tool_name: toolName,
    tool_input: toolInput,
    input_summary: inputSummary,
    session_id: sessionId,
    transcript_path: transcriptPath,
    raw: hookInput
  }, hookId);

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

app.put("/api/settings", async (req, res) => {
  const settings = req.body;
  await saveSettings(settings);
  res.json({ ok: true });
});

// ── Test Notification ────────────────────────────────────────────────────────

app.post("/api/test-notification", async (req, res) => {
  const settings = loadSettings();
  const notif = settings.notifications;

  if (!notif || !notif.ntfyTopic) {
    return res.json({ ok: false, error: "Set an ntfy topic first" });
  }

  try {
    // Temporarily force enabled so sendPushNotification doesn't bail out
    const origEnabled = notif.enabled;
    settings.notifications.enabled = true;
    await saveSettings(settings);

    await sendPushNotification({
      title: "Agent Brain Test",
      message: "If you see this, notifications are working!",
      priority: 3,
      hookId: null
    });

    // Restore original enabled state
    settings.notifications.enabled = origEnabled;
    await saveSettings(settings);

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── Event Log API ────────────────────────────────────────────────────────────

app.get("/api/events", async (req, res) => {
  const events = await queryEvents({
    since: req.query.since,
    type: req.query.type,
    sessionId: req.query.session,
    limit: parseInt(req.query.limit) || 50
  });
  res.json(events);
});

app.get("/api/events/recent", async (_req, res) => {
  res.json(await queryEvents({ limit: 50 }));
});

// ── Memory API ───────────────────────────────────────────────────────────────

// List all projects that have memory
app.get("/api/memory", async (_req, res) => {
  try {
    const projects = await db.listProjects();
    res.json(projects.map(p => ({
      project_dir: p.name,
      name: getProjectName(p.name),
      has_memory: true
    })));
  } catch (_) { res.json([]); }
});

// Read/write MEMORY.md for a project
app.get("/api/memory/:projectDir", async (req, res) => {
  try {
    const content = await db.getProjectMemory(req.params.projectDir);
    res.json({ content, project_dir: req.params.projectDir });
  } catch (_) { res.json({ content: "", project_dir: req.params.projectDir }); }
});

app.put("/api/memory/:projectDir", async (req, res) => {
  const content = req.body.content || "";
  await db.setProjectMemory(req.params.projectDir, content);
  logEvent("memory_updated", null, { project_dir: req.params.projectDir, file: "MEMORY.md" });
  res.json({ ok: true });
});

// Daily logs
app.get("/api/memory/:projectDir/daily", async (req, res) => {
  try {
    const logs = await db.listDailyLogs(req.params.projectDir);
    res.json(logs);
  } catch (_) { res.json([]); }
});

app.get("/api/memory/:projectDir/daily/:date", async (req, res) => {
  try {
    const content = await db.getDailyLog(req.params.projectDir, req.params.date);
    res.json({ date: req.params.date, content });
  } catch (_) { res.json({ date: req.params.date, content: "" }); }
});

app.post("/api/memory/:projectDir/daily", async (req, res) => {
  const content = req.body.content || "";
  const result = await db.appendDailyLog(req.params.projectDir, content);
  logEvent("memory_updated", null, { project_dir: req.params.projectDir, file: result.date + ".md" });
  res.json({ ok: true, date: result.date });
});

// Topic files
app.get("/api/memory/:projectDir/topics", async (req, res) => {
  try {
    const topics = await db.listTopics(req.params.projectDir);
    res.json(topics);
  } catch (_) { res.json([]); }
});

app.get("/api/memory/:projectDir/topics/:name", async (req, res) => {
  try {
    const content = await db.getTopic(req.params.projectDir, req.params.name);
    res.json({ name: req.params.name, content });
  } catch (_) { res.json({ name: req.params.name, content: "" }); }
});

app.put("/api/memory/:projectDir/topics/:name", async (req, res) => {
  const content = req.body.content || "";
  await db.setTopic(req.params.projectDir, req.params.name, content);
  logEvent("memory_updated", null, { project_dir: req.params.projectDir, file: "topics/" + req.params.name + ".md" });
  res.json({ ok: true });
});

// ── Mailbox API ──────────────────────────────────────────────────────────────

app.post("/api/mailbox", async (req, res) => {
  const { from_session, to_session, subject, body } = req.body;
  if (!subject && !body) return res.status(400).json({ error: "Subject or body required" });
  const msg = await sendMailboxMessage({ from_session, to_session, subject, body });
  res.json(msg);
});

// Get ALL messages (for dashboard mailbox UI)
app.get("/api/mailbox/all", async (_req, res) => {
  try {
    const msgs = await db.readAllMailbox({ limit: 50 });
    res.json(msgs);
  } catch (_) { res.json([]); }
});

app.get("/api/mailbox/:sessionId", async (req, res) => {
  const unreadOnly = req.query.unread === "true";
  const msgs = await readMailbox(req.params.sessionId, { unreadOnly });
  res.json(msgs);
});

app.get("/api/mailbox/:sessionId/unread-count", async (req, res) => {
  res.json({ count: await getUnreadCount(req.params.sessionId) });
});

app.post("/api/mailbox/:messageId/read", async (req, res) => {
  const ok = await markMailboxRead(req.params.messageId);
  if (!ok) return res.status(404).json({ error: "Message not found" });
  res.json({ ok: true });
});

// ── Session Handoff API ──────────────────────────────────────────────────────

app.post("/api/sessions/:id/handoff", async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Build handoff context
  const projectDir = session.cc_project_dir || "unknown";

  // Read project memory
  let memoryContent = "";
  try { memoryContent = await db.getProjectMemory(projectDir); } catch (_) {}

  // Read today's daily log
  let dailyLog = "";
  try {
    const today = new Date().toISOString().split("T")[0];
    dailyLog = await db.getDailyLog(projectDir, today);
  } catch (_) {}

  // Extract last N messages for summary
  const recentMsgs = (session.messages || []).slice(-20);
  const msgSummary = recentMsgs
    .filter(m => m.role === "user" || (m.role === "assistant" && m.content))
    .map(m => `[${m.role}]: ${(m.content || "").slice(0, 500)}`)
    .join("\n\n");

  // Compose handoff prompt
  const handoffPrompt = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

## Previous Session: ${session.title || "Untitled"}

### Recent conversation:
${msgSummary || "(no messages captured)"}

### Project Memory (MEMORY.md):
${memoryContent || "(no project memory yet)"}

### Today's Log:
${dailyLog || "(no daily log yet)"}

Please continue the conversation from where we left off. Review the project memory and recent conversation to understand the context, then proceed with the task at hand.`;

  // Create new session
  const newSession = await createSession();
  const newData = await loadSession(newSession.session_id);
  newData.title = `Handoff from: ${session.title || req.params.id}`;
  newData.cc_project_dir = session.cc_project_dir;
  newData.handoff_from = req.params.id;
  newData.handoff_prompt = handoffPrompt;
  await saveSession(newData);

  logEvent("handoff_triggered", req.params.id, {
    new_session: newSession.session_id,
    project_dir: projectDir
  });

  res.json({
    ok: true,
    new_session_id: newSession.session_id,
    handoff_prompt: handoffPrompt
  });
});

// Get handoff prompt for a session (if it was created via handoff)
app.get("/api/sessions/:id/handoff-prompt", async (req, res) => {
  const session = await loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    handoff_prompt: session.handoff_prompt || null,
    handoff_from: session.handoff_from || null
  });
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
  for (const [key, ts] of recentlyResolvedSessions) {
    if (now - ts > 30000) recentlyResolvedSessions.delete(key);
  }
}, 60000);

// ── HTML templates (read fresh on each request for live editing) ─────────────

function readView(name) {
  return fs.readFileSync(path.join(__dirname, "views", name), "utf8");
}

// ── UI routes ────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.type("html").send(readView("dashboard.html")));
app.get("/settings", (_req, res) => res.type("html").send(readView("settings.html")));

app.get("/chat", (_req, res) => {
  res.type("html").send(readView("home.html"));
});

app.get("/chat/:session_id", (req, res) => {
  const html = readView("chat.html").replace("{{SESSION_ID}}", req.params.session_id);
  res.type("html").send(html);
});

app.get("/memory", (_req, res) => res.type("html").send(readView("memory.html")));
app.get("/mailbox", (_req, res) => res.type("html").send(readView("mailbox.html")));
app.get("/orchestrator", (_req, res) => res.type("html").send(readView("orchestrator.html")));

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

// ── Orchestrator ────────────────────────────────────────────────────────────
// Top-level dispatch system. User sends multi-project instructions in a chat
// interface; the orchestrator parses tasks, runs them via the Claude Agent SDK,
// streams progress back via SSE, and routes critical updates to the user.

const { createSDKTask, loadSDK } = require("./lib/sdk-adapter");

const orchestratorClients = new Map(); // SSE client connections
const activeTasks = new Map(); // taskId → { abortController, task, sessionId }

// ── Task Queue (sequential by default, bump concurrency for parallel) ──────
class TaskQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }
  enqueue(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this._drain();
    });
  }
  _drain() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { taskFn, resolve, reject } = this.queue.shift();
      this.running++;
      taskFn()
        .then(resolve)
        .catch(reject)
        .finally(() => { this.running--; this._drain(); });
    }
  }
  cancelAll() { this.queue = []; }
}
// Note: each SDK query uses ~1GiB RAM. concurrency=1 keeps memory safe.
// To enable parallel execution later, change to: new TaskQueue({ concurrency: 3 })
const orchestratorQueue = new TaskQueue({ concurrency: 1 });

// Kill existing Claude Code sessions before dispatching orchestrator tasks.
// The Agent SDK creates Claude Code sessions that conflict with any running
// sessions (Claude Desktop, Claude Code terminals, etc.). This clears the way.
function killExistingClaudeSessions() {
  return new Promise((resolve) => {
    execFile("pkill", ["-x", "claude"], (err) => {
      // pkill returns exit code 1 if no processes matched — that's fine
      if (!err) console.log("[orchestrator] Killed existing Claude sessions to avoid concurrency conflicts");
      resolve();
    });
  });
}

async function loadOrchestrator() {
  return db.loadOrchestrator();
}

async function saveOrchestrator(data) {
  await db.saveOrchestrator(data);
}

function broadcastOrchestrator(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [id, client] of orchestratorClients) {
    try { client.write(payload); } catch (_) { orchestratorClients.delete(id); }
  }
}

// Project keyword → directory mapping for task parsing
const PROJECT_KEYWORDS = {
  "agent brain": { dir: "-Users-lukeblanton-agent-brain", name: "Agent Brain", cwd: "/Users/lukeblanton/agent-brain" },
  "ios-app": { dir: "-Users-lukeblanton-Documents-arc-ios-local", name: "Arc Social", cwd: "/Users/lukeblanton/Documents/arc-ios-local" },
  "ios app": { dir: "-Users-lukeblanton-Documents-arc-ios-local", name: "Arc Social", cwd: "/Users/lukeblanton/Documents/arc-ios-local" },
  "arc social": { dir: "-Users-lukeblanton-Documents-arc-ios-local", name: "Arc Social", cwd: "/Users/lukeblanton/Documents/arc-ios-local" },
  "arc": { dir: "-Users-lukeblanton-Documents-arc-ios-local", name: "Arc Social", cwd: "/Users/lukeblanton/Documents/arc-ios-local" },
  "insiders-mvp": { dir: "-Users-lukeblanton-Documents-TCC-Project-Insiders-MVP", name: "Insiders MVP", cwd: "/Users/lukeblanton/Documents/TCC Project/Insiders-MVP" },
  "insiders mvp": { dir: "-Users-lukeblanton-Documents-TCC-Project-Insiders-MVP", name: "Insiders MVP", cwd: "/Users/lukeblanton/Documents/TCC Project/Insiders-MVP" },
  "insiders": { dir: "-Users-lukeblanton-Documents-TCC-Project-Insiders-MVP", name: "Insiders MVP", cwd: "/Users/lukeblanton/Documents/TCC Project/Insiders-MVP" },
};

function parseOrchestratorTasks(message) {
  const tasks = [];
  const lowerMsg = message.toLowerCase();
  const usedProjects = new Set(); // avoid duplicate projects

  // Try numbered tasks: "1. agent brain - do X\n2. ios - do Y"
  const numberedPattern = /(?:^|\n)\s*\d+[\.\)]\s*(.+?)(?=(?:\n\s*\d+[\.\)])|$)/gs;
  const numberedMatches = [...message.matchAll(numberedPattern)].map(m => m[1].trim());

  const taskTexts = numberedMatches.length > 0 ? numberedMatches : [message];

  for (const taskText of taskTexts) {
    const lowerTask = taskText.toLowerCase();
    let matched = false;

    // Sort keywords by length (longest first) so "agent brain" matches before "arc"
    const sortedKeywords = Object.entries(PROJECT_KEYWORDS).sort((a, b) => b[0].length - a[0].length);

    for (const [keyword, project] of sortedKeywords) {
      if (lowerTask.includes(keyword) && !usedProjects.has(project.dir)) {
        // Extract task description (everything after the project name reference)
        const keywordIdx = lowerTask.indexOf(keyword);
        let description = taskText;
        const afterKeyword = taskText.slice(keywordIdx + keyword.length)
          .replace(/^\s*[-:–—,]\s*/, "")
          .replace(/^\s*(and|then|to|should|please)\s+/i, "")
          .trim();
        if (afterKeyword) description = afterKeyword;

        tasks.push({
          id: "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          project_dir: project.dir,
          project_name: project.name,
          cwd: project.cwd,
          description,
          status: "pending",
          started_at: null,
          completed_at: null,
          output: "",
          error: null
        });
        usedProjects.add(project.dir);
        matched = true;
        break;
      }
    }

    if (!matched && numberedMatches.length > 0) {
      // Unmatched numbered item → generic task
      tasks.push({
        id: "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        project_dir: null,
        project_name: "General",
        cwd: path.join(HOME),
        description: taskText,
        status: "pending",
        started_at: null,
        completed_at: null,
        output: "",
        error: null
      });
    }
  }

  // If no tasks found from numbered parsing and single-message mode matched nothing
  if (tasks.length === 0) {
    // Try matching any project keyword in the full message
    const sortedKeywords = Object.entries(PROJECT_KEYWORDS).sort((a, b) => b[0].length - a[0].length);
    for (const [keyword, project] of sortedKeywords) {
      if (lowerMsg.includes(keyword)) {
        tasks.push({
          id: "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          project_dir: project.dir,
          project_name: project.name,
          cwd: project.cwd,
          description: message,
          status: "pending",
          started_at: null,
          completed_at: null,
          output: "",
          error: null
        });
        break;
      }
    }
  }

  return tasks;
}

async function composeTaskPrompt(task) {
  let prompt = "";

  // Add project context from memory
  if (task.project_dir) {
    try {
      const memContent = await db.getProjectMemory(task.project_dir);
      if (memContent) prompt += "## Project Memory\n" + memContent + "\n\n";
    } catch (_) {}

    try {
      const today = new Date().toISOString().split("T")[0];
      const dailyContent = await db.getDailyLog(task.project_dir, today);
      if (dailyContent) prompt += "## Today's Activity Log\n" + dailyContent + "\n\n";
    } catch (_) {}

    // Check for unread mailbox messages for this project
    try {
      const msgs = await readMailbox(task.project_dir, { unreadOnly: true });
      if (msgs.length > 0) {
        prompt += "## Unread Mailbox Messages\n";
        for (const m of msgs.slice(0, 5)) {
          prompt += `- From ${m.from_session || "unknown"}: ${m.subject || "(no subject)"} — ${m.body || ""}\n`;
        }
        prompt += "\n";
      }
    } catch (_) {}
  }

  prompt += "## Your Task\n" + task.description + "\n\n";

  prompt += `## Orchestrator Communication
You were dispatched by the Agent Brain orchestrator. Your task ID is: ${task.id}

When you have important findings, complete a major step, or need user input, post an update using the Bash tool:
curl -s -X POST http://localhost:3030/api/orchestrator/tasks/${task.id}/update -H "Content-Type: application/json" -d '{"type":"<type>","content":"<your update>"}'

Update types: "progress" (status updates), "finding" (important discoveries), "needs_decision" (user must choose — include the question and options), "completed" (task done — include a summary).

When your task is complete, always send a "completed" update with a summary.

Also update project memory before finishing:
curl -s -X POST http://localhost:3030/api/memory/${task.project_dir || "general"}/daily -H "Content-Type: application/json" -d '{"content":"## Orchestrator Task\\n- <what you accomplished>\\n- <next steps>"}'

Now begin working on your task.`;

  return prompt;
}

async function spawnTask(task) {
  const prompt = await composeTaskPrompt(task);
  task.status = "running";
  task.started_at = new Date().toISOString();

  const model = task.model || "sonnet";
  console.log(`[orchestrator] Running: ${task.project_name} (${model}) — ${task.description.slice(0, 60)}`);
  console.log(`[orchestrator] CWD: ${task.cwd}`);

  let outputBuffer = "";

  // Permission bridge: routes SDK permission requests through Agent Brain's
  // auto-approval engine + phone dashboard. Honors settings.json tool policies.
  async function orchestratorCanUseTool(toolName, toolInput, options) {
    const policy = checkToolPolicy(toolName, toolInput);

    if (policy === "auto") {
      return { behavior: "allow" };
    }
    if (policy === "block") {
      console.log(`[orchestrator] Blocked tool: ${toolName} (policy)`);
      return { behavior: "deny", message: `Tool "${toolName}" is blocked by policy` };
    }

    // policy === "ask" — route to dashboard for user approval
    const inputSummary = typeof toolInput === "object"
      ? JSON.stringify(toolInput).slice(0, 200)
      : String(toolInput || "").slice(0, 200);

    console.log(`[orchestrator] Permission request: ${toolName} for ${task.project_name}`);

    // Broadcast to orchestrator UI so user sees the request
    broadcastOrchestrator("task_permission", {
      task_id: task.id,
      project_name: task.project_name,
      tool: toolName,
      input_summary: inputSummary,
      ts: new Date().toISOString()
    });

    // Create a hook permission entry (same system the dashboard + push notifications use)
    const hookData = {
      tool_name: toolName,
      tool_input: toolInput,
      session_id: `orchestrator-${task.id}`,
      transcript_path: null,
      source: "orchestrator"
    };

    // Send push notification
    const hookId = "orch-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    sendPushNotification({
      title: `${task.project_name}: Allow ${toolName}?`,
      message: inputSummary.slice(0, 200),
      priority: 4,
      hookId
    });

    const result = await createHookPermission(hookData, hookId);

    // Broadcast the decision back to UI
    broadcastOrchestrator("task_permission_resolved", {
      task_id: task.id,
      project_name: task.project_name,
      tool: toolName,
      decision: result.behavior,
      ts: new Date().toISOString()
    });

    return result;
  }

  const sdkTask = createSDKTask({
    prompt,
    cwd: task.cwd,
    model,
    maxTurns: task.maxTurns || 50,
    maxBudgetUsd: task.maxBudgetUsd || undefined,
    permissionMode: "default",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
    canUseTool: orchestratorCanUseTool,
  });

  activeTasks.set(task.id, { abortController: sdkTask.abortController, task, sessionId: null });

  // ── Map SDK events → SSE broadcasts ──

  sdkTask.events.on("message", (msg) => {
    // SDKAssistantMessage — text and tool_use blocks
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text && block.text.trim()) {
          outputBuffer += block.text;
          broadcastOrchestrator("task_output", {
            task_id: task.id,
            project_name: task.project_name,
            text: block.text,
            output_type: "text"
          });
        } else if (block.type === "tool_use") {
          const toolSummary = block.name + (block.input ? ": " + JSON.stringify(block.input).slice(0, 100) : "");
          broadcastOrchestrator("task_output", {
            task_id: task.id,
            project_name: task.project_name,
            text: toolSummary,
            output_type: "tool_use",
            tool: block.name
          });
        }
      }
    }
    // SDKResultMessage — session finished
    else if (msg.type === "result" || "result" in msg) {
      const sessionId = msg.session_id || null;
      if (sessionId) {
        const active = activeTasks.get(task.id);
        if (active) active.sessionId = sessionId;
      }
      broadcastOrchestrator("task_output", {
        task_id: task.id,
        project_name: task.project_name,
        text: "Session finished: " + (msg.subtype || "done"),
        output_type: "result",
        cost: msg.cost_usd || null,
        duration: msg.duration_ms || null
      });
    }
    // SDKSystemMessage — log but don't broadcast to UI
    else if (msg.type === "system") {
      const sessionId = msg.session_id || null;
      if (sessionId && msg.subtype === "init") {
        const active = activeTasks.get(task.id);
        if (active) active.sessionId = sessionId;
      }
      console.log(`[orchestrator] SDK system: ${task.project_name} — ${msg.subtype || "event"}`);
    }
  });

  sdkTask.events.on("done", async () => {
    task.status = "completed";
    task.completed_at = new Date().toISOString();
    task.output = outputBuffer.slice(-8000);
    activeTasks.delete(task.id);

    console.log(`[orchestrator] Task ${task.id} finished: completed`);

    broadcastOrchestrator("task_completed", {
      task_id: task.id,
      project_name: task.project_name,
      status: "completed",
      error: null,
      duration_ms: new Date(task.completed_at) - new Date(task.started_at)
    });

    await db.upsertOrchestratorTask(task);
    await db.addOrchestratorMessage({
      role: "system",
      type: "task_completed",
      task_id: task.id,
      project_name: task.project_name,
      content: `${task.project_name} task completed.`,
      ts: new Date().toISOString()
    });
    logEvent("orchestrator_task_done", null, { task_id: task.id, project: task.project_name, status: "completed" });
  });

  sdkTask.events.on("cancelled", async () => {
    task.status = "cancelled";
    task.completed_at = new Date().toISOString();
    task.output = outputBuffer.slice(-8000);
    activeTasks.delete(task.id);

    broadcastOrchestrator("task_cancelled", { task_id: task.id, project_name: task.project_name });

    await db.upsertOrchestratorTask(task);
    await db.addOrchestratorMessage({
      role: "system",
      content: `${task.project_name} task cancelled.`,
      task_id: task.id,
      ts: new Date().toISOString()
    });
  });

  sdkTask.events.on("error", async (err) => {
    task.status = "failed";
    task.error = err.message;
    task.completed_at = new Date().toISOString();
    task.output = outputBuffer.slice(-8000);
    activeTasks.delete(task.id);

    broadcastOrchestrator("task_error", { task_id: task.id, project_name: task.project_name, error: err.message });

    await db.upsertOrchestratorTask(task);
    await db.addOrchestratorMessage({
      role: "system",
      type: "task_error",
      task_id: task.id,
      content: `Failed: ${task.project_name}: ${err.message}`,
      ts: new Date().toISOString()
    });
  });

  // Start execution (non-blocking — events handle completion)
  sdkTask.run().catch((err) => {
    // Safety net: if run() throws before emitting error
    if (activeTasks.has(task.id)) {
      sdkTask.events.emit("error", err);
    }
  });

  return task;
}

// ── Orchestrator API ──────────────────────────────────────────────────────

app.get("/api/orchestrator", async (_req, res) => {
  const orch = await loadOrchestrator();
  // Merge live status for active tasks
  for (const task of orch.tasks) {
    if (activeTasks.has(task.id)) task.status = "running";
  }
  res.json(orch);
});

app.post("/api/orchestrator/message", async (req, res) => {
  const content = (req.body.content || "").trim();
  if (!content) return res.status(400).json({ error: "Message required" });

  // Add user message
  const userMsg = { role: "user", content, ts: new Date().toISOString() };
  await db.addOrchestratorMessage(userMsg);
  broadcastOrchestrator("message", userMsg);

  // Parse tasks
  const tasks = parseOrchestratorTasks(content);

  if (tasks.length === 0) {
    const reply = {
      role: "orchestrator",
      content: "I couldn't identify any project tasks from your message. Try mentioning a project name (Agent Brain, Arc Social, Insiders MVP) and what you'd like done.",
      ts: new Date().toISOString()
    };
    await db.addOrchestratorMessage(reply);
    broadcastOrchestrator("message", reply);
    return res.json({ ok: true, tasks: [] });
  }

  // Kill existing Claude Code sessions to avoid API concurrency conflicts
  broadcastOrchestrator("message", {
    role: "system",
    content: "Clearing active Claude sessions...",
    ts: new Date().toISOString()
  });
  await killExistingClaudeSessions();

  // Orchestrator response
  const lines = tasks.map(t => `• **${t.project_name}**: ${t.description.slice(0, 120)}`);
  const reply = {
    role: "orchestrator",
    content: `Dispatching ${tasks.length} task${tasks.length > 1 ? "s" : ""}:\n${lines.join("\n")}`,
    ts: new Date().toISOString()
  };
  await db.addOrchestratorMessage(reply);
  for (const task of tasks) {
    await db.upsertOrchestratorTask(task);
  }
  broadcastOrchestrator("message", reply);

  // Queue tasks for sequential execution (broadcasts "spawned" immediately for UI)
  for (const task of tasks) {
    broadcastOrchestrator("task_spawned", {
      task_id: task.id,
      project_name: task.project_name,
      description: task.description
    });
    orchestratorQueue.enqueue(() => spawnTask(task));
  }

  logEvent("orchestrator_dispatch", null, {
    task_count: tasks.length,
    projects: tasks.map(t => t.project_name)
  });

  res.json({
    ok: true,
    tasks: tasks.map(t => ({ id: t.id, project_name: t.project_name, description: t.description }))
  });
});

// SSE stream for real-time orchestrator updates
app.get("/api/orchestrator/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const clientId = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  orchestratorClients.set(clientId, res);

  // Send initial connection event
  res.write(`event: connected\ndata: {"client_id":"${clientId}"}\n\n`);

  // Keepalive every 30s
  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch (_) { clearInterval(keepalive); }
  }, 30000);

  req.on("close", () => {
    orchestratorClients.delete(clientId);
    clearInterval(keepalive);
  });
});

// Task update endpoint (called by child claude -p sessions)
app.post("/api/orchestrator/tasks/:taskId/update", async (req, res) => {
  const { taskId } = req.params;
  const { type, content } = req.body;

  const orch = await loadOrchestrator();
  const task = orch.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: "Task not found" });

  const msg = {
    role: "task_update",
    task_id: taskId,
    project_name: task.project_name,
    update_type: type || "progress",
    content: content || "",
    ts: new Date().toISOString()
  };
  await db.addOrchestratorMessage(msg);

  if (type === "completed") {
    task.status = "completed";
    task.completed_at = new Date().toISOString();
  } else if (type === "needs_decision") {
    task.status = "needs_input";
  }

  await db.upsertOrchestratorTask(task);

  broadcastOrchestrator("task_update", msg);

  // Send push notification for important updates
  if (type === "needs_decision" || type === "finding") {
    sendPushNotification({
      title: `${task.project_name}: ${type === "needs_decision" ? "Decision needed" : "Finding"}`,
      message: (content || "").slice(0, 200),
      priority: type === "needs_decision" ? 5 : 3,
      hookId: null
    });
  }

  res.json({ ok: true });
});

// Cancel a running task
app.post("/api/orchestrator/tasks/:taskId/cancel", (req, res) => {
  const { taskId } = req.params;
  const active = activeTasks.get(taskId);
  if (!active) return res.status(404).json({ error: "Task not running" });

  // Abort the SDK query — the "cancelled" event handler on spawnTask() handles cleanup
  active.abortController.abort();

  res.json({ ok: true });
});

// Clear orchestrator conversation
app.post("/api/orchestrator/clear", async (_req, res) => {
  // Abort all running SDK tasks
  for (const [id, active] of activeTasks) {
    try { active.abortController.abort(); } catch (_) {}
  }
  activeTasks.clear();
  orchestratorQueue.cancelAll(); // Clear queued-but-not-started tasks
  await db.clearOrchestrator();
  broadcastOrchestrator("cleared", {});
  res.json({ ok: true });
});

// ── Cross-session notification polling (disabled — revisit with push notifications) ──
// Keeping the code for later. macOS `display notification` works on Mac but
// doesn't forward to iPhone. Need ntfy.sh or similar for phone push.

// ── Server startup ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3030;

// Pre-warm settings cache before starting server
db.initSettingsCache()
  .then(() => console.log("[db] Settings cache initialized"))
  .catch(e => console.warn("[db] Settings cache init failed:", e.message));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent Brain running on http://localhost:${PORT}`);

  // Verify Claude Agent SDK is available for orchestrator
  loadSDK()
    .then(() => console.log("[orchestrator] Claude Agent SDK loaded successfully"))
    .catch((e) => {
      console.warn("[orchestrator] Claude Agent SDK not available:", e.message);
      console.warn("[orchestrator] Install with: npm install @anthropic-ai/claude-agent-sdk");
    });
});
