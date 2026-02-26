require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
// OpenAI removed — Agent Brain is now Claude-only

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

// ── UI routes ────────────────────────────────────────────────────────────────

app.get("/", (_req, res) => res.redirect("/chat"));

app.get("/chat", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Agent Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, 'SF Pro Display', sans-serif;
      background: #f2f2f7;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      padding: 20px 20px 16px;
      padding-top: max(20px, env(safe-area-inset-top));
      color: #fff;
    }
    .header h1 { font-size: 28px; font-weight: 700; letter-spacing: -0.5px; }
    .header p { font-size: 13px; color: rgba(255,255,255,0.6); margin-top: 2px; }
    .top-bar {
      padding: 16px 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .new-chat-btn {
      padding: 15px;
      background: linear-gradient(135deg, #007aff 0%, #5856d6 100%);
      color: #fff;
      text-align: center;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      width: 100%;
      box-shadow: 0 4px 12px rgba(0,122,255,0.3);
      transition: transform 0.1s, box-shadow 0.1s;
      -webkit-tap-highlight-color: transparent;
    }
    .new-chat-btn:active { transform: scale(0.98); box-shadow: 0 2px 8px rgba(0,122,255,0.2); }
    .search-input {
      width: 100%;
      padding: 11px 16px;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      background: #e8e8ed;
      -webkit-appearance: none;
      color: #1c1c1e;
      transition: background 0.2s;
    }
    .search-input:focus { outline: none; background: #fff; box-shadow: 0 0 0 3px rgba(0,122,255,0.2); }
    .search-input::placeholder { color: #8e8e93; }
    .session-list { padding: 0 16px; }
    .session-item {
      display: flex;
      align-items: center;
      background: #fff;
      margin-bottom: 1px;
      text-decoration: none;
      color: inherit;
      overflow: hidden;
      transition: background 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .session-item:first-child { border-radius: 12px 12px 0 0; }
    .session-item:last-child { border-radius: 0 0 12px 12px; margin-bottom: 12px; }
    .session-item:only-child { border-radius: 12px; }
    .session-item:active { background: #f2f2f7; }
    .session-link {
      flex: 1;
      padding: 14px 16px;
      text-decoration: none;
      color: inherit;
      min-width: 0;
    }
    .session-title {
      font-size: 16px;
      font-weight: 500;
      color: #1c1c1e;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-time { font-size: 13px; color: #8e8e93; margin-top: 3px; }
    .session-action-btn {
      background: none;
      border: none;
      padding: 14px;
      font-size: 20px;
      color: #8e8e93;
      cursor: pointer;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }
    .empty { text-align: center; padding: 60px 16px; color: #8e8e93; font-size: 15px; }
    .footer-links { text-align: center; padding: 20px; padding-bottom: max(20px, env(safe-area-inset-bottom)); }
    .footer-links a { color: #8e8e93; font-size: 13px; text-decoration: none; }

    .start-chat-btn {
      margin: 0 16px 16px;
      padding: 14px;
      background: linear-gradient(135deg, #007aff 0%, #5856d6 100%);
      color: #fff;
      text-align: center;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      width: calc(100% - 32px);
      -webkit-tap-highlight-color: transparent;
    }
    .start-chat-btn:active { transform: scale(0.98); }
    .start-chat-btn:disabled { background: #d1d1d6; }

    /* Folders */
    .folder-header {
      display: flex;
      align-items: center;
      background: #fff;
      margin-bottom: 1px;
      border-radius: 12px 12px 0 0;
      padding: 13px 16px;
      cursor: pointer;
      -webkit-user-select: none;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .folder-header.collapsed { border-radius: 12px; margin-bottom: 12px; }
    .folder-arrow {
      font-size: 10px;
      margin-right: 10px;
      transition: transform 0.2s ease;
      color: #8e8e93;
    }
    .folder-header.collapsed .folder-arrow { transform: rotate(-90deg); }
    .folder-name { font-size: 15px; font-weight: 600; color: #1c1c1e; flex: 1; }
    .folder-count {
      font-size: 12px;
      color: #8e8e93;
      background: #e8e8ed;
      padding: 2px 8px;
      border-radius: 10px;
      margin-right: 10px;
      font-weight: 500;
    }
    .folder-action-btn {
      background: none; border: none; font-size: 18px; color: #8e8e93;
      cursor: pointer; padding: 2px 4px;
      -webkit-tap-highlight-color: transparent;
    }
    .folder-body { margin-bottom: 12px; }
    .folder-body .session-item { border-radius: 0; margin-bottom: 0; }
    .folder-body .session-item:first-child { border-radius: 0; }
    .folder-body .session-item:last-child { border-radius: 0 0 12px 12px; margin-bottom: 0; }
    .folder-body .session-link { padding-left: 36px; }
    .folder-body.hidden { display: none; }

    /* Modal overlay */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.45);
      -webkit-backdrop-filter: blur(4px);
      backdrop-filter: blur(4px);
      z-index: 100;
      justify-content: center;
      align-items: flex-end;
      padding: 0 10px;
      padding-bottom: max(12px, env(safe-area-inset-bottom));
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: rgba(255,255,255,0.95);
      -webkit-backdrop-filter: blur(20px);
      backdrop-filter: blur(20px);
      border-radius: 14px;
      width: 100%;
      max-width: 400px;
      overflow: hidden;
    }
    .modal-title {
      padding: 14px 16px;
      font-size: 13px;
      font-weight: 600;
      text-align: center;
      color: #8e8e93;
      border-bottom: 1px solid rgba(0,0,0,0.08);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .modal-btn {
      display: block;
      width: 100%;
      padding: 16px;
      border: none;
      background: none;
      font-size: 18px;
      cursor: pointer;
      text-align: center;
      border-bottom: 1px solid rgba(0,0,0,0.08);
      color: #007aff;
      -webkit-tap-highlight-color: transparent;
    }
    .modal-btn:last-child { border-bottom: none; }
    .modal-btn:active { background: rgba(0,0,0,0.04); }
    .modal-btn.danger { color: #ff3b30; }
    .modal-cancel {
      display: block;
      width: 100%;
      margin-top: 8px;
      padding: 16px;
      border: none;
      background: rgba(255,255,255,0.95);
      -webkit-backdrop-filter: blur(20px);
      backdrop-filter: blur(20px);
      border-radius: 14px;
      font-size: 18px;
      font-weight: 600;
      cursor: pointer;
      color: #007aff;
      max-width: 400px;
      -webkit-tap-highlight-color: transparent;
    }
    .modal-cancel:active { background: rgba(255,255,255,0.8); }

    /* Rename input inside modal */
    .rename-row {
      display: none;
      padding: 12px 16px;
      gap: 8px;
      border-bottom: 1px solid rgba(0,0,0,0.08);
    }
    .rename-row.active { display: flex; }
    .rename-row input {
      flex: 1;
      font-size: 16px;
      padding: 10px 14px;
      border: 1px solid #d1d1d6;
      border-radius: 10px;
      background: #fff;
      -webkit-appearance: none;
    }
    .rename-row input:focus { outline: none; border-color: #007aff; box-shadow: 0 0 0 3px rgba(0,122,255,0.15); }
    .rename-row button {
      padding: 10px 18px;
      background: #007aff;
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
    }

    /* Section labels */
    .section-label {
      font-size: 13px;
      font-weight: 600;
      color: #8e8e93;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 16px 4px 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Agent Brain</h1>
    <p>Your personal assistant</p>
  </div>
  <div class="top-bar">
    <button class="new-chat-btn" onclick="openNewChatModal()">+ New Chat</button>
    <input type="text" class="search-input" id="search" placeholder="Search sessions...">
  </div>
  <div class="session-list" id="session-list"></div>
  <div style="height:40px;"></div>

  <!-- Action modal -->
  <div class="modal-overlay" id="modal" onclick="closeModal(event)">
    <div style="width:100%; max-width:400px;">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-title" id="modal-title"></div>
        <div class="rename-row" id="rename-row">
          <input type="text" id="rename-input" placeholder="New name...">
          <button onclick="doRename()">Save</button>
        </div>
        <div id="main-actions">
          <button class="modal-btn" onclick="showRename()">Rename</button>
          <button class="modal-btn" onclick="showFolderPicker()">Move to Folder</button>
          <button class="modal-btn" onclick="doArchive()">Archive</button>
          <button class="modal-btn danger" onclick="doDelete()">Delete</button>
        </div>
        <div id="folder-picker" style="display:none;">
          <div style="padding:14px 16px; font-size:13px; font-weight:600; color:#8e8e93; border-bottom:1px solid rgba(0,0,0,0.08); text-transform:uppercase; letter-spacing:0.5px;">Move to folder</div>
          <button class="modal-btn" onclick="doMoveToFolder(null)" style="color:#8e8e93;">Remove from folder</button>
          <div id="folder-list-picker"></div>
          <div class="rename-row active" style="display:flex;">
            <input type="text" id="new-folder-input" placeholder="New folder name...">
            <button onclick="doCreateFolderAndMove()">Create</button>
          </div>
        </div>
      </div>
      <button class="modal-cancel" onclick="closeModal()">Cancel</button>
    </div>
  </div>

  <!-- New chat modal -->
  <div class="modal-overlay" id="new-chat-modal" onclick="closeNewChatModal(event)">
    <div style="width:100%; max-width:400px;">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-title">New Claude Code Session</div>
        <div style="padding:0 16px 16px;">
          <textarea id="new-chat-message" rows="3" placeholder="What would you like to work on?" style="width:100%; font-size:16px; padding:12px; border:1px solid #e0e0e0; border-radius:12px; resize:none; font-family:-apple-system,system-ui,sans-serif; line-height:1.4; background:#f9f9f9; color:#1c1c1e; -webkit-appearance:none;"></textarea>
        </div>
        <div id="new-chat-status" style="display:none; padding:0 16px 12px; text-align:center; font-size:13px; color:#8e8e93;">Opening Claude Desktop...</div>
        <button class="start-chat-btn" onclick="startNewChat()">Start Session</button>
      </div>
      <button class="modal-cancel" onclick="closeNewChatModal()">Cancel</button>
    </div>
  </div>

  <!-- Folder action modal -->
  <div class="modal-overlay" id="folder-modal" onclick="closeFolderModal(event)">
    <div style="width:100%; max-width:400px;">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-title" id="folder-modal-title"></div>
        <div class="rename-row" id="folder-rename-row">
          <input type="text" id="folder-rename-input" placeholder="New name...">
          <button onclick="doRenameFolder()">Save</button>
        </div>
        <button class="modal-btn" onclick="showFolderRename()">Rename Folder</button>
        <button class="modal-btn danger" onclick="doDeleteFolder()">Delete Folder</button>
      </div>
      <button class="modal-cancel" onclick="closeFolderModal()">Cancel</button>
    </div>
  </div>

  <script>
    let allSessions = [];
    let allFolders = [];
    let activeSessionId = null;
    let activeFolderId = null;
    let collapsedFolders = JSON.parse(localStorage.getItem("collapsedFolders") || "{}");

    async function loadData() {
      const [sResp, fResp, ccResp] = await Promise.all([
        fetch("/api/sessions"),
        fetch("/api/folders"),
        fetch("/api/claude-sessions")
      ]);
      const abSessions = await sResp.json();
      allFolders = await fResp.json();
      const ccSessions = await ccResp.json();

      // Build a set of CC session IDs already adopted by Agent Brain sessions
      const adoptedCC = new Set();
      for (const ab of abSessions) {
        if (ab.claude_session_id) adoptedCC.add(ab.claude_session_id);
      }

      // Merge: AB sessions first (they already link to CC), then unadopted CC sessions
      allSessions = [];
      for (const ab of abSessions) {
        allSessions.push({ ...ab, source: "agent-brain" });
      }
      for (const cc of ccSessions) {
        if (!adoptedCC.has(cc.session_id)) {
          allSessions.push({
            session_id: cc.session_id,
            title: cc.title,
            updated_at: cc.updated_at,
            source: "claude-code",
            project_dir: cc.project_dir,
            project_path: cc.project_path
          });
        }
      }
      // Sort all by updated_at descending
      allSessions.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
      renderList();
    }

    function renderList() {
      const q = (document.getElementById("search").value || "").toLowerCase();
      const list = document.getElementById("session-list");
      const filtered = q ? allSessions.filter(s => s.title.toLowerCase().includes(q)) : allSessions;

      // Build set of session IDs that are in folders
      const inFolder = new Set();
      for (const f of allFolders) {
        for (const sid of f.session_ids) inFolder.add(sid);
      }

      let html = "";

      // Render folders first
      for (const f of allFolders) {
        const folderSessions = filtered.filter(s => f.session_ids.includes(s.session_id));
        if (q && folderSessions.length === 0) continue;
        const isCollapsed = collapsedFolders[f.id];
        html += '<div class="folder-header' + (isCollapsed ? ' collapsed' : '') + '" onclick="toggleFolder(\\'' + f.id + '\\')">' +
          '<span class="folder-arrow">&#9660;</span>' +
          '<span class="folder-name">' + esc(f.name) + '</span>' +
          '<span class="folder-count">' + folderSessions.length + '</span>' +
          '<button class="folder-action-btn" onclick="event.stopPropagation(); openFolderModal(\\'' + f.id + '\\', \\'' + esc(f.name).replace(/'/g, "\\\\'") + '\\')">&middot;&middot;&middot;</button>' +
        '</div>';
        html += '<div class="folder-body' + (isCollapsed ? ' hidden' : '') + '" id="folder-body-' + f.id + '">';
        for (const s of folderSessions) {
          html += sessionItemHtml(s);
        }
        html += '</div>';
      }

      // Unfiled sessions
      const unfiled = filtered.filter(s => !inFolder.has(s.session_id));
      for (const s of unfiled) {
        html += sessionItemHtml(s);
      }

      if (!html) {
        html = '<div class="empty">' + (q ? 'No matching sessions' : 'No sessions yet. Start a new chat!') + '</div>';
      }

      list.innerHTML = html;
    }

    function sessionItemHtml(s) {
      const ago = timeAgo(s.updated_at);
      if (s.source === "claude-code") {
        // CC session not yet adopted — clicking adopts it
        const shortPath = (s.project_path || "").split("/").filter(Boolean).slice(-1)[0] || "";
        const meta = ago + (shortPath ? ' &bull; ' + esc(shortPath) : '');
        return '<div class="session-item" onclick="adoptCCSession(\\'' + esc(s.project_dir) + '\\', \\'' + s.session_id + '\\')" style="cursor:pointer;">' +
          '<div class="session-link">' +
            '<div class="session-title">' + esc(s.title) + '</div>' +
            '<div class="session-time">' + meta + '</div>' +
          '</div>' +
        '</div>';
      }
      return '<div class="session-item">' +
        '<a href="/chat/' + s.session_id + '" class="session-link">' +
          '<div class="session-title">' + esc(s.title) + '</div>' +
          '<div class="session-time">' + ago + '</div>' +
        '</a>' +
        '<button class="session-action-btn" onclick="openModal(\\'' + s.session_id + '\\', \\'' + esc(s.title).replace(/'/g, "\\\\'") + '\\')">&middot;&middot;&middot;</button>' +
      '</div>';
    }

    async function adoptCCSession(projectDir, sessionId) {
      const resp = await fetch("/api/claude-sessions/" + projectDir + "/" + sessionId + "/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      const data = await resp.json();
      if (data.session_id) window.location.href = "/chat/" + data.session_id;
    }

    function toggleFolder(folderId) {
      collapsedFolders[folderId] = !collapsedFolders[folderId];
      localStorage.setItem("collapsedFolders", JSON.stringify(collapsedFolders));
      renderList();
    }

    function esc(s) {
      const d = document.createElement("div");
      d.textContent = s;
      return d.innerHTML;
    }

    function timeAgo(iso) {
      const diff = Date.now() - new Date(iso).getTime();
      const m = Math.floor(diff / 60000);
      if (m < 1) return "just now";
      if (m < 60) return m + "m ago";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }

    // ── Session action modal ──
    function openModal(id, title) {
      activeSessionId = id;
      document.getElementById("modal-title").textContent = title;
      document.getElementById("rename-input").value = title;
      document.getElementById("rename-row").classList.remove("active");
      document.getElementById("main-actions").style.display = "";
      document.getElementById("folder-picker").style.display = "none";
      document.getElementById("modal").classList.add("active");
    }

    function closeModal(e) {
      if (e && !e.target.classList.contains("modal-overlay")) return;
      document.getElementById("modal").classList.remove("active");
      activeSessionId = null;
    }

    function showRename() {
      document.getElementById("rename-row").classList.add("active");
      document.getElementById("rename-input").focus();
    }

    async function doRename() {
      const title = document.getElementById("rename-input").value.trim();
      if (!title || !activeSessionId) return;
      await fetch("/api/sessions/" + activeSessionId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title })
      });
      closeModal();
      loadData();
    }

    async function doArchive() {
      if (!activeSessionId) return;
      await fetch("/api/sessions/" + activeSessionId + "/archive", { method: "POST" });
      closeModal();
      loadData();
    }

    async function doDelete() {
      if (!activeSessionId) return;
      if (!confirm("Delete this session permanently?")) return;
      await fetch("/api/sessions/" + activeSessionId, { method: "DELETE" });
      closeModal();
      loadData();
    }

    // ── Folder picker in session modal ──
    function showFolderPicker() {
      document.getElementById("main-actions").style.display = "none";
      const picker = document.getElementById("folder-picker");
      picker.style.display = "";
      // Populate folder buttons
      const listEl = document.getElementById("folder-list-picker");
      listEl.innerHTML = allFolders.map(f =>
        '<button class="modal-btn" onclick="doMoveToFolder(\\'' + f.id + '\\')">' + esc(f.name) + '</button>'
      ).join("");
      document.getElementById("new-folder-input").value = "";
    }

    async function doMoveToFolder(folderId) {
      if (!activeSessionId) return;
      await fetch("/api/sessions/" + activeSessionId + "/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_id: folderId })
      });
      closeModal();
      loadData();
    }

    async function doCreateFolderAndMove() {
      const name = document.getElementById("new-folder-input").value.trim();
      if (!name || !activeSessionId) return;
      const resp = await fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const folders = await resp.json();
      // Move to the new folder (last one created)
      const newFolder = folders[folders.length - 1];
      await doMoveToFolder(newFolder.id);
    }

    // ── Folder action modal ──
    function openFolderModal(id, name) {
      activeFolderId = id;
      document.getElementById("folder-modal-title").textContent = name;
      document.getElementById("folder-rename-input").value = name;
      document.getElementById("folder-rename-row").classList.remove("active");
      document.getElementById("folder-modal").classList.add("active");
    }

    function closeFolderModal(e) {
      if (e && !e.target.classList.contains("modal-overlay")) return;
      document.getElementById("folder-modal").classList.remove("active");
      activeFolderId = null;
    }

    function showFolderRename() {
      document.getElementById("folder-rename-row").classList.add("active");
      document.getElementById("folder-rename-input").focus();
    }

    async function doRenameFolder() {
      const name = document.getElementById("folder-rename-input").value.trim();
      if (!name || !activeFolderId) return;
      await fetch("/api/folders/" + activeFolderId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      closeFolderModal();
      loadData();
    }

    async function doDeleteFolder() {
      if (!activeFolderId) return;
      if (!confirm("Delete this folder? Sessions inside will become unfiled.")) return;
      await fetch("/api/folders/" + activeFolderId, { method: "DELETE" });
      closeFolderModal();
      loadData();
    }

    // ── New Chat Modal ──
    function openNewChatModal() {
      document.getElementById("new-chat-message").value = "";
      document.getElementById("new-chat-status").style.display = "none";
      document.getElementById("new-chat-modal").classList.add("active");
      setTimeout(() => document.getElementById("new-chat-message").focus(), 300);
    }

    function closeNewChatModal(e) {
      if (e && !e.target.classList.contains("modal-overlay")) return;
      document.getElementById("new-chat-modal").classList.remove("active");
    }

    async function startNewChat() {
      const msg = document.getElementById("new-chat-message").value.trim();
      if (!msg) return;
      const statusEl = document.getElementById("new-chat-status");
      statusEl.style.display = "";
      statusEl.textContent = "Opening Claude Desktop...";
      try {
        const resp = await fetch("/chat/new", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: msg })
        });
        const data = await resp.json();
        if (data.error) {
          statusEl.textContent = "Error: " + data.error;
          return;
        }
        statusEl.textContent = data.linked ? "Linked! Redirecting..." : "Session created. Redirecting...";
        window.location.href = "/chat/" + data.session_id;
      } catch (e) {
        statusEl.textContent = "Failed: " + e.message;
      }
    }

    // Wire up search
    document.getElementById("search").addEventListener("input", renderList);

    loadData();
  </script>
</body>
</html>`);
});

app.get("/chat/:session_id", (req, res) => {
  const session_id = req.params.session_id;
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <title>Agent Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, 'SF Pro Display', sans-serif;
      background: #f2f2f7;
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }
    .header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      padding: 12px 16px;
      padding-top: max(12px, env(safe-area-inset-top));
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .header a {
      color: rgba(255,255,255,0.85);
      text-decoration: none;
      font-size: 22px;
      padding: 4px;
      -webkit-tap-highlight-color: transparent;
    }
    .header .title {
      font-size: 17px;
      font-weight: 600;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #fff;
    }
    .copy-btn {
      background: rgba(255,255,255,0.15);
      border: none;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      color: rgba(255,255,255,0.85);
      cursor: pointer;
      flex-shrink: 0;
      white-space: nowrap;
      -webkit-tap-highlight-color: transparent;
    }
    .copy-btn:active { background: rgba(255,255,255,0.25); }
    .copy-btn.copied { background: rgba(52,199,89,0.3); color: #fff; }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      -webkit-overflow-scrolling: touch;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .msg {
      max-width: 82%;
      padding: 10px 14px;
      border-radius: 18px;
      word-wrap: break-word;
      font-size: 16px;
      line-height: 1.4;
    }
    .msg.user {
      background: linear-gradient(135deg, #007aff 0%, #5856d6 100%);
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 6px;
      white-space: pre-wrap;
    }
    .msg.assistant {
      background: #fff;
      color: #1c1c1e;
      align-self: flex-start;
      border-bottom-left-radius: 6px;
      white-space: normal;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    .msg.assistant p { margin: 0 0 8px 0; }
    .msg.assistant p:last-child { margin-bottom: 0; }
    .msg.assistant ul, .msg.assistant ol { margin: 0 0 8px 20px; }
    .msg.assistant li { margin-bottom: 2px; }
    .msg.assistant code {
      background: #f2f2f7;
      padding: 2px 6px;
      border-radius: 5px;
      font-family: 'SF Mono', ui-monospace, SFMono-Regular, monospace;
      font-size: 14px;
      color: #c41a68;
    }
    .msg.assistant pre {
      background: #1c1c1e;
      color: #f2f2f7;
      padding: 12px 14px;
      border-radius: 10px;
      overflow-x: auto;
      margin: 0 0 8px 0;
      font-size: 13px;
    }
    .msg.assistant pre code { background: none; padding: 0; color: inherit; }
    .msg.assistant h1, .msg.assistant h2, .msg.assistant h3 {
      font-size: 15px;
      font-weight: 700;
      margin: 0 0 6px 0;
      color: #1c1c1e;
    }
    .msg.assistant strong { font-weight: 600; }
    .msg.assistant a { color: #007aff; text-decoration: none; }
    .msg.thinking {
      background: #fff;
      color: #8e8e93;
      align-self: flex-start;
      border-bottom-left-radius: 6px;
      font-style: italic;
      box-shadow: 0 1px 3px rgba(0,0,0,0.06);
    }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .msg.thinking { animation: pulse 1.5s ease-in-out infinite; }
    .tool-block {
      align-self: flex-start;
      max-width: 88%;
      font-size: 13px;
      color: #8e8e93;
      background: #fff;
      padding: 8px 12px;
      border-radius: 10px;
      font-family: 'SF Mono', ui-monospace, SFMono-Regular, monospace;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
      border: 1px solid #e8e8ed;
      -webkit-tap-highlight-color: transparent;
    }
    .tool-block .tool-header { display: flex; gap: 6px; align-items: center; }
    .tool-block .tool-icon { font-size: 11px; }
    .tool-block .tool-output {
      display: none;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid #e8e8ed;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
      color: #636366;
    }
    .tool-block.expanded .tool-output { display: block; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/chat">&larr;</a>
    <div class="title" id="chat-title">Chat</div>
    <button class="copy-btn" onclick="copyChat(this)">Copy</button>
  </div>
  <div class="messages" id="messages"></div>
  <div id="permission-bar" style="display:none; flex-shrink:0; border-top:1px solid #e8e8ed; background:#f0f4ff; padding:10px 14px;">
    <div style="font-size:13px; font-weight:600; color:#1c1c1e; margin-bottom:6px;" id="permission-label">Permission requested</div>
    <div style="font-size:11px; color:#666; margin-bottom:8px; word-break:break-all;" id="permission-detail"></div>
    <div style="display:flex; gap:10px;">
      <button onclick="handlePermission('approve')" style="flex:1; padding:10px; border-radius:10px; border:none; background:#34c759; color:#fff; font-size:15px; font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent;">Allow</button>
      <button onclick="handlePermission('deny')" style="flex:1; padding:10px; border-radius:10px; border:none; background:#ff3b30; color:#fff; font-size:15px; font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent;">Deny</button>
    </div>
  </div>
  <div id="inject-area" style="flex-shrink:0;">
    <div style="padding:6px 12px; padding-bottom:max(10px, env(safe-area-inset-bottom)); background:#fff; border-top:1px solid #e8e8ed; display:flex; gap:8px; align-items:flex-end;">
      <textarea id="inject-input" rows="1" placeholder="Message..." oninput="autoResize(this)" style="flex:1; font-size:16px; padding:10px 16px; border:1px solid #e0e0e0; border-radius:22px; resize:none; max-height:120px; min-height:42px; font-family:-apple-system,system-ui,sans-serif; line-height:1.35; background:#f9f9f9; color:#1c1c1e;"></textarea>
      <button id="inject-btn" onclick="injectMessage()" style="background:linear-gradient(135deg,#007aff 0%,#5856d6 100%); color:#fff; border:none; border-radius:50%; width:42px; height:42px; font-size:20px; font-weight:700; cursor:pointer; flex-shrink:0; display:flex; align-items:center; justify-content:center; -webkit-tap-highlight-color:transparent;">&#8593;</button>
    </div>
  </div>

  <script>
    const SESSION_ID = "${session_id}";
    const messagesEl = document.getElementById("messages");

    function autoResize(el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function escHtml(s) {
      const div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function addUserMsg(text) {
      const div = document.createElement("div");
      div.className = "msg user";
      div.textContent = text;
      messagesEl.appendChild(div);
      scrollToBottom();
    }

    function simpleMd(text) {
      // Escape HTML first
      let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      // Code blocks: \`\`\`...\`\`\`
      s = s.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, function(_, code) {
        return "<pre><code>" + code.trim() + "</code></pre>";
      });
      // Inline code
      s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
      // Bold
      s = s.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>");
      // Italic
      s = s.replace(/(?<![*])\\*(?![*])(.+?)(?<![*])\\*(?![*])/g, "<em>$1</em>");
      // Headers
      s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
      s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
      s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
      // Unordered lists
      s = s.replace(/^[\\-\\*] (.+)$/gm, "<li>$1</li>");
      s = s.replace(/((?:<li>.*<\\/li>\\n?)+)/g, "<ul>$1</ul>");
      // Ordered lists
      s = s.replace(/^\\d+\\.\\s(.+)$/gm, "<li>$1</li>");
      // Paragraphs: split by double newline
      s = s.split(/\\n\\n+/).map(function(block) {
        block = block.trim();
        if (!block) return "";
        if (block.startsWith("<h") || block.startsWith("<pre") || block.startsWith("<ul") || block.startsWith("<ol") || block.startsWith("<li")) return block;
        return "<p>" + block.replace(/\\n/g, "<br>") + "</p>";
      }).join("");
      return s;
    }

    function addAssistantMsg(text) {
      const div = document.createElement("div");
      div.className = "msg assistant";
      div.innerHTML = simpleMd(text);
      messagesEl.appendChild(div);
      scrollToBottom();
      return div;
    }

    function addThinking() {
      const div = document.createElement("div");
      div.className = "msg thinking";
      div.textContent = "Thinking...";
      messagesEl.appendChild(div);
      scrollToBottom();
      return div;
    }

    function addToolBlock(name, args, output) {
      const div = document.createElement("div");
      div.className = "tool-block";
      const truncOutput = output && output.length > 500 ? output.slice(0, 500) + "..." : output;
      div.innerHTML =
        '<div class="tool-header"><span class="tool-icon">&#9881;</span> <strong>' + escHtml(name) + '</strong></div>' +
        (output ? '<div class="tool-output">' + escHtml(truncOutput) + '</div>' : '');
      div.onclick = function() { div.classList.toggle("expanded"); };
      messagesEl.appendChild(div);
      scrollToBottom();
    }

    function renderMessages(messages) {
      // Track tool results by tool_call_id for pairing
      const toolOutputs = {};
      for (const m of messages) {
        if (m.role === "tool") toolOutputs[m.tool_call_id] = m.content;
      }

      for (const m of messages) {
        if (m.role === "system") continue;
        if (m.role === "user") {
          addUserMsg(m.content);
        } else if (m.role === "tool_use") {
          // Claude Code tool use blocks
          for (const t of (m.tools || [])) {
            addToolBlock(t.name, t.input, "");
          }
        } else if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) {
            const output = toolOutputs[tc.id] || "";
            addToolBlock(tc.function.name, tc.function.arguments, output);
          }
        } else if (m.role === "assistant" && m.content) {
          addAssistantMsg(m.content);
        }
        // skip standalone tool messages (already handled above)
      }
    }

    function renderNewMessages(newMsgs) {
      const toolOutputs = {};
      for (const m of newMsgs) {
        if (m.role === "tool") toolOutputs[m.tool_call_id] = m.content;
      }
      for (const m of newMsgs) {
        if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
          for (const tc of m.tool_calls) {
            const output = toolOutputs[tc.id] || "";
            addToolBlock(tc.function.name, tc.function.arguments, output);
          }
        } else if (m.role === "assistant" && m.content) {
          addAssistantMsg(m.content);
        }
      }
    }

    let isLinkedCC = false;
    let lastMessageCount = 0;
    let liveRefreshTimer = null;

    async function loadSession() {
      try {
        const resp = await fetch("/api/sessions/" + SESSION_ID);
        const data = await resp.json();
        if (data.title) document.getElementById("chat-title").textContent = data.title;
        isLinkedCC = !!(data.cc_project_dir && data.claude_session_id);
        if (data.messages) {
          renderMessages(data.messages);
          lastMessageCount = data.messages.length;
        }
        // Auto-refresh every 5s for linked sessions
        if (isLinkedCC && !liveRefreshTimer) {
          liveRefreshTimer = setInterval(refreshLinkedSession, 5000);
        }
      } catch (e) {}
    }

    async function refreshLinkedSession() {
      try {
        const resp = await fetch("/api/sessions/" + SESSION_ID);
        const data = await resp.json();
        if (data.messages && data.messages.length !== lastMessageCount) {
          messagesEl.innerHTML = "";
          renderMessages(data.messages);
          lastMessageCount = data.messages.length;
        }
        // Check for pending permission prompts
        if (isLinkedCC) checkPermission();
      } catch (_) {}
    }

    async function checkPermission() {
      try {
        const resp = await fetch("/api/sessions/" + SESSION_ID + "/pending-permission");
        const data = await resp.json();
        const bar = document.getElementById("permission-bar");
        if (data.pending && data.tools) {
          const toolNames = data.tools.map(t => t.name).join(", ");
          const detail = data.tools.map(t => t.name + ": " + t.input).join("\\n");
          document.getElementById("permission-label").textContent = "Approve " + toolNames + "?";
          document.getElementById("permission-detail").textContent = detail;
          bar.style.display = "";
          scrollToBottom();
        } else {
          bar.style.display = "none";
        }
      } catch (_) {}
    }

    async function handlePermission(action) {
      const bar = document.getElementById("permission-bar");
      const buttons = bar.querySelectorAll("button");
      buttons.forEach(b => { b.disabled = true; b.style.opacity = "0.5"; });
      try {
        await fetch("/api/sessions/" + SESSION_ID + "/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action })
        });
        bar.style.display = "none";
        // Refresh to show updated messages
        setTimeout(refreshLinkedSession, 2000);
      } catch (_) {}
      buttons.forEach(b => { b.disabled = false; b.style.opacity = "1"; });
    }

    // ── Inject message into Claude Desktop ──
    let injecting = false;

    async function injectMessage() {
      if (injecting) return;
      const injectInput = document.getElementById("inject-input");
      const injectBtn = document.getElementById("inject-btn");
      const content = injectInput.value.trim();
      if (!content) return;

      injecting = true;
      injectBtn.disabled = true;
      injectBtn.style.opacity = "0.5";
      injectInput.value = "";
      injectInput.style.height = "auto";

      try {
        const resp = await fetch("/api/sessions/" + SESSION_ID + "/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content })
        });
        const data = await resp.json();
        if (data.error) {
          alert("Send failed: " + data.error);
        }
        // The live refresh will pick up the new messages automatically
      } catch (err) {
        alert("Inject failed: " + err.message);
      }

      injecting = false;
      injectBtn.disabled = false;
      injectBtn.style.opacity = "1";
      injectInput.focus();
    }

    // Wire up Enter key for inject input
    document.addEventListener("DOMContentLoaded", () => {
      const injectInput = document.getElementById("inject-input");
      if (injectInput) {
        injectInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            injectMessage();
          }
        });
      }
    });

    async function copyChat(btn) {
      try {
        const resp = await fetch("/api/sessions/" + SESSION_ID);
        const data = await resp.json();
        let text = "";
        for (const m of (data.messages || [])) {
          if (m.role === "system") continue;
          if (m.role === "user") text += "You: " + m.content + "\\n\\n";
          else if (m.role === "assistant" && m.content) text += "Agent: " + m.content + "\\n\\n";
        }
        const str = text.trim();
        // Clipboard API needs HTTPS on iOS; fall back to textarea trick
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(str);
        } else {
          const ta = document.createElement("textarea");
          ta.value = str;
          ta.style.position = "fixed";
          ta.style.left = "-9999px";
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
      } catch (e) {
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Copy"; }, 2000);
      }
    }

    loadSession();
  </script>
</body>
</html>`);
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

// ── Server startup ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3030;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent Brain running on http://localhost:${PORT}`);
});
