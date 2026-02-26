require("dotenv").config();

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const WebSocket = require("ws");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Constants ───────────────────────────────────────────────────────────────

const HOME = os.homedir();


const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const ARCHIVE_DIR = path.join(__dirname, "sessions", "archive");
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);

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

// Check if a linked CC session has a pending permission prompt
function checkPendingPermission(projectDir, sessionId) {
  const filePath = path.join(CLAUDE_SESSIONS_DIR, projectDir, sessionId + ".jsonl");
  if (!fs.existsSync(filePath)) return null;

  // Read last ~8KB to find the most recent entries
  const stat = fs.statSync(filePath);
  const readSize = Math.min(stat.size, 8192);
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
  fs.closeSync(fd);
  const tail = buf.toString("utf8");
  const lines = tail.split("\n").filter(l => l.trim());

  // Walk backwards to find state
  let lastAssistantToolUse = null;
  let hasToolResultAfter = false;
  let lastType = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (!lastType) lastType = obj.type;

      // If we find a user entry with tool_result content, mark it
      if (obj.type === "user" && obj.message && Array.isArray(obj.message.content)) {
        for (const c of obj.message.content) {
          if (c.type === "tool_result") { hasToolResultAfter = true; break; }
        }
      }

      // Find last assistant tool_use
      if (obj.type === "assistant" && obj.message && Array.isArray(obj.message.content)) {
        const tools = obj.message.content.filter(c => c.type === "tool_use");
        if (tools.length > 0) {
          lastAssistantToolUse = tools.map(t => ({
            name: t.name,
            input: JSON.stringify(t.input || {}).slice(0, 300)
          }));
          break; // Found the last tool_use, stop
        }
      }
    } catch (_) {}
  }

  // If last assistant had tool_use and no tool_result followed, Claude is waiting
  if (lastAssistantToolUse && !hasToolResultAfter) {
    // Also check if file hasn't been modified in the last 2 seconds (settled)
    const mtime = stat.mtimeMs;
    const age = Date.now() - mtime;
    if (age > 2000) {
      return { pending: true, tools: lastAssistantToolUse };
    }
  }

  return { pending: false };
}

// Send a keystroke to Claude Desktop (Enter to approve, Escape to deny)
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

app.get("/api/sessions/:id/pending-permission", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!session.cc_project_dir || !session.claude_session_id) {
    return res.json({ pending: false });
  }
  const result = checkPendingPermission(session.cc_project_dir, session.claude_session_id);
  res.json(result || { pending: false });
});

app.post("/api/sessions/:id/approve", async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  const action = req.body.action || "approve"; // "approve" or "deny"
  try {
    const keyCode = action === "deny" ? 53 : 36; // Escape or Enter
    await sendKeystrokeToClaude(keyCode);
    res.json({ ok: true });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── HTML templates ───────────────────────────────────────────────────────────

const HOME_HTML = fs.readFileSync(path.join(__dirname, "views", "home.html"), "utf8");
const CHAT_HTML = fs.readFileSync(path.join(__dirname, "views", "chat.html"), "utf8");

// ── UI routes ────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.redirect("/chat"));

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

// ── WebSocket + fs.watch for real-time updates ──────────────────────────────

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Track watchers per JSONL file path so we don't duplicate
const fileWatchers = new Map();  // filePath → { watcher, clients: Set<ws> }

function getJsonlPath(session) {
  if (!session.cc_project_dir || !session.claude_session_id) return null;
  return path.join(CLAUDE_SESSIONS_DIR, session.cc_project_dir, session.claude_session_id + ".jsonl");
}

function watchSession(ws, session) {
  const filePath = getJsonlPath(session);
  if (!filePath || !fs.existsSync(filePath)) return;

  if (fileWatchers.has(filePath)) {
    // Already watching — just add this client
    fileWatchers.get(filePath).clients.add(ws);
    return;
  }

  const clients = new Set([ws]);
  let debounceTimer = null;

  const watcher = fs.watch(filePath, () => {
    // Debounce rapid writes (Claude often writes multiple lines quickly)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Read fresh data and push to all connected clients for this file
      const messages = readClaudeCodeSession(session.cc_project_dir, session.claude_session_id);
      const permission = checkPendingPermission(session.cc_project_dir, session.claude_session_id);
      const payload = JSON.stringify({
        type: "session_update",
        messages: messages || [],
        permission: permission || { pending: false }
      });
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(payload);
        }
      }
    }, 300);
  });

  fileWatchers.set(filePath, { watcher, clients });
}

function unwatchSession(ws) {
  for (const [filePath, entry] of fileWatchers) {
    entry.clients.delete(ws);
    if (entry.clients.size === 0) {
      entry.watcher.close();
      fileWatchers.delete(filePath);
    }
  }
}

wss.on("connection", (ws, req) => {
  // Extract session_id from query string: ws://host:3030/?session_id=xxx
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("session_id");

  if (sessionId) {
    const session = loadSession(sessionId);
    if (session) {
      watchSession(ws, session);

      // Send initial data immediately
      if (session.cc_project_dir && session.claude_session_id) {
        const messages = readClaudeCodeSession(session.cc_project_dir, session.claude_session_id);
        const permission = checkPendingPermission(session.cc_project_dir, session.claude_session_id);
        ws.send(JSON.stringify({
          type: "session_update",
          messages: messages || [],
          permission: permission || { pending: false }
        }));
      }
    }
  }

  ws.on("close", () => unwatchSession(ws));
  ws.on("error", () => unwatchSession(ws));
});

// ── Server startup ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3030;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent Brain running on http://localhost:${PORT}`);
});
