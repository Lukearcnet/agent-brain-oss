require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Constants ───────────────────────────────────────────────────────────────

const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR);

const SESSIONS_DIR = path.join(__dirname, "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR);

const ARCHIVE_DIR = path.join(__dirname, "sessions", "archive");
if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR);

const HOME = os.homedir();

const ALLOWED_COMMANDS = new Set([
  "ls", "pwd", "whoami", "git", "node", "npm", "python3", "claude"
]);

const SYSTEM_PROMPT = `You are a helpful assistant running on Luke's Mac.
HOME is ${HOME}. The current date is ${new Date().toLocaleDateString()}.

Available tools:
- run_command: Execute whitelisted shell commands (ls, pwd, whoami, git, node, npm, python3, claude)
- read_file: Read file contents
- write_file: Create or overwrite files
- list_dir: List directory contents with sizes
- http_request: Make HTTP requests to external APIs (Airtable, Notion, Gmail, etc.)

External APIs — authentication headers are AUTOMATICALLY injected by the system. Just call http_request with the URL. NEVER ask the user for API keys or tokens.

NOTION: You have full access. Auth headers are auto-injected for any api.notion.com request.
  Base URL: https://api.notion.com/v1
  To search: POST https://api.notion.com/v1/search with body {"query": "search term"} or {} for all
  Other endpoints: GET /pages/{id}, GET /databases/{id}, POST /databases/{id}/query, POST /pages (create), PATCH /pages/{id} (update), PATCH /blocks/{id}/children (append content)
  IMPORTANT: When calling Notion, just use http_request with the URL. Do NOT set Authorization headers — they are added automatically.

AIRTABLE: Auth headers are auto-injected for any api.airtable.com request.
  Token and base config are in ~/Documents/TCC Project/Insiders Project/eaa-insiders-call-booker/airtable-config.md. Read that file for base ID, table names, etc.

Rules:
- All file paths must be under ${HOME}
- Use "${HOME}" as the base for paths (not /Users/luke/...)
- You can chain multiple tool calls to complete complex tasks
- Think step by step for multi-step tasks
- If a command fails, explain the error and try an alternative approach`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command. Only whitelisted commands are allowed: ls, pwd, whoami, git, node, npm, python3, claude.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command to run (e.g. 'git', 'ls')" },
          args: { type: "array", items: { type: "string" }, description: "Command arguments" },
          cwd: { type: "string", description: `Working directory. Defaults to ${HOME}. Must be under HOME.` }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Path must be under HOME.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file. Can use ~ for HOME." },
          max_chars: { type: "number", description: "Maximum characters to return. Defaults to 12000." }
        },
        required: ["file_path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file (creates or overwrites). Path must be under HOME.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file. Can use ~ for HOME." },
          content: { type: "string", description: "The content to write." }
        },
        required: ["file_path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the contents of a directory with file types and sizes. Path must be under HOME.",
      parameters: {
        type: "object",
        properties: {
          dir_path: { type: "string", description: "Path to directory. Can use ~ for HOME. Defaults to HOME." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "http_request",
      description: "Make an HTTP request to an external API. Use this for Airtable, Notion, Gmail, or any REST API. Returns the response body as text.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL to request." },
          method: { type: "string", description: "HTTP method: GET, POST, PUT, PATCH, DELETE. Defaults to GET." },
          headers: { type: "object", description: "HTTP headers as key-value pairs (e.g. {\"Authorization\": \"Bearer ...\", \"Content-Type\": \"application/json\"})." },
          body: { type: "string", description: "Request body as a string. For JSON APIs, pass a JSON string." }
        },
        required: ["url"]
      }
    }
  }
];

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

function ensurePathInHome(userPath) {
  let p = String(userPath || "").trim();

  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));

  if (!path.isAbsolute(p)) p = path.join(HOME, p);

  const resolved = path.resolve(p);

  if (resolved !== HOME && !resolved.startsWith(HOME + path.sep)) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

// ── Tool implementations ─────────────────────────────────────────────────────

function readFileTool({ file_path, max_chars = 12000 }) {
  const p = ensurePathInHome(file_path);
  const data = fs.readFileSync(p, "utf8");
  return data.slice(0, max_chars);
}

function writeFileTool({ file_path, content }) {
  const p = ensurePathInHome(file_path);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return `Wrote ${content.length} chars to ${p}`;
}

function listDirTool({ dir_path = "~" }) {
  const p = ensurePathInHome(dir_path);
  const entries = fs.readdirSync(p, { withFileTypes: true });
  const lines = entries.map(e => {
    const fullPath = path.join(p, e.name);
    let info = e.isDirectory() ? "[dir]" : "[file]";
    if (e.isFile()) {
      try {
        const stat = fs.statSync(fullPath);
        info += ` ${stat.size}b`;
      } catch (_) {}
    }
    if (e.isSymbolicLink()) info = "[symlink]";
    return `${info}  ${e.name}`;
  });
  return lines.join("\n");
}

function runCommandTool({ command, args = [], cwd = HOME }) {
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`Command not allowed: ${command}`);
  }
  const safeCwd = ensurePathInHome(cwd);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      Array.isArray(args) ? args : [],
      { cwd: safeCwd, timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout + (stderr ? "\n" + stderr : ""));
      }
    );
  });
}

async function httpRequestTool({ url, method = "GET", headers = {}, body }) {
  // Auto-inject credentials for known APIs so the model doesn't have to
  if (url.includes("api.notion.com") && process.env.NOTION_API_KEY) {
    headers = {
      "Authorization": `Bearer ${process.env.NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...headers
    };
  }
  if (url.includes("api.airtable.com") && process.env.AIRTABLE_API_KEY) {
    headers = {
      "Authorization": `Bearer ${process.env.AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
      ...headers
    };
  }

  const opts = {
    method: method.toUpperCase(),
    headers
  };
  if (body && opts.method !== "GET") opts.body = body;
  const resp = await fetch(url, opts);
  const text = await resp.text();
  const prefix = `${resp.status} ${resp.statusText}\n`;
  // Truncate large responses to avoid blowing up context
  if (text.length > 20000) return prefix + text.slice(0, 20000) + "\n...(truncated)";
  return prefix + text;
}

async function dispatchTool(name, args) {
  switch (name) {
    case "run_command":   return runCommandTool(args);
    case "read_file":     return readFileTool(args);
    case "write_file":    return writeFileTool(args);
    case "list_dir":      return listDirTool(args);
    case "http_request":  return httpRequestTool(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Session management ───────────────────────────────────────────────────────

function createSession() {
  const session_id = nowId();
  const session = {
    session_id,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    title: "",
    messages: [{ role: "system", content: SYSTEM_PROMPT }]
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
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json")).sort().reverse();
  return files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
    return {
      session_id: data.session_id,
      title: data.title || "(untitled)",
      created_at: data.created_at,
      updated_at: data.updated_at
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

// ── Agent loop ───────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 10;

async function runAgentLoop(session) {
  const newMessages = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const resp = await client.chat.completions.create({
      model: "gpt-4.1",
      messages: session.messages,
      tools: TOOLS,
      tool_choice: "auto"
    });

    const msg = resp.choices[0].message;
    session.messages.push(msg);
    newMessages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) break;

    const toolResults = await Promise.all(
      msg.tool_calls.map(async (call) => {
        let output;
        try {
          const args = JSON.parse(call.function.arguments);
          output = await dispatchTool(call.function.name, args);
        } catch (err) {
          output = "Error: " + err.message;
        }
        return { role: "tool", tool_call_id: call.id, content: String(output) };
      })
    );

    for (const tr of toolResults) {
      session.messages.push(tr);
      newMessages.push(tr);
    }
  }

  autoTitle(session);
  saveSession(session);
  return newMessages;
}

// ── Legacy routes (unchanged) ────────────────────────────────────────────────

app.get("/runs", (_req, res) => {
  const files = fs.readdirSync(RUNS_DIR).filter(f => f.endsWith(".json")).sort().reverse();
  const items = files.map(f => {
    const id = f.replace(".json", "");
    return `<li><a href="/runs/${id}">${id}</a></li>`;
  }).join("");
  res.send(`
    <html>
      <body style="font-family:-apple-system; margin:24px;">
        <h2>Runs</h2>
        <p><a href="/chat">&larr; Back to Chat</a></p>
        <ol>${items}</ol>
      </body>
    </html>
  `);
});

app.get("/runs/:id", (req, res) => {
  const p = path.join(RUNS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(p)) return res.send("Not found");
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  res.send(`
    <html>
      <body style="font-family:-apple-system; margin:24px;">
        <p><a href="/runs">&larr; Back</a></p>
        <h2>${req.params.id}</h2>
        <h3>Task</h3>
        <pre>${data.task}</pre>
        <h3>Answer</h3>
        <pre>${data.answer || data.error}</pre>
      </body>
    </html>
  `);
});

app.post("/run", async (req, res) => {
  const task = req.body.task;
  const run_id = nowId();
  const runPath = path.join(RUNS_DIR, `${run_id}.json`);
  const tools = [{ type: "function", function: { name: "run_command", parameters: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" } }, required: ["command"] } } }];
  let messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: task }
  ];
  try {
    const resp = await client.chat.completions.create({ model: "gpt-4.1", messages, tools, tool_choice: "auto" });
    const msg = resp.choices[0].message;
    if (msg.tool_calls) {
      const call = msg.tool_calls[0];
      const args = JSON.parse(call.function.arguments);
      const output = await runCommandTool(args);
      const followup = await client.chat.completions.create({ model: "gpt-4.1", messages: [...messages, msg, { role: "tool", tool_call_id: call.id, content: output }] });
      const answer = followup.choices[0].message.content;
      const result = { run_id, task, answer };
      fs.writeFileSync(runPath, JSON.stringify(result, null, 2));
      return res.json(result);
    }
    const answer = msg.content;
    const result = { run_id, task, answer };
    fs.writeFileSync(runPath, JSON.stringify(result, null, 2));
    res.json(result);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── API routes ───────────────────────────────────────────────────────────────

app.get("/api/sessions", (_req, res) => {
  res.json(listSessions());
});

app.get("/api/sessions/:id", (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json(session);
});

app.post("/chat/new", (_req, res) => {
  const session = createSession();
  res.json({ session_id: session.session_id });
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

app.post("/api/sessions/:id/message", async (req, res) => {
  const session = loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const content = req.body.content;
  if (!content) return res.status(400).json({ error: "No message content" });

  session.messages.push({ role: "user", content });
  saveSession(session);

  try {
    const newMessages = await runAgentLoop(session);
    res.json({ new_messages: newMessages });
  } catch (e) {
    saveSession(session);
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
  <title>Agent Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, sans-serif;
      background: #f5f5f5;
      min-height: 100vh;
    }
    .header {
      background: #fff;
      padding: 16px;
      border-bottom: 1px solid #ddd;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 { font-size: 20px; }
    .top-bar { padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
    .new-chat-btn {
      padding: 14px;
      background: #007aff;
      color: #fff;
      text-align: center;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      width: 100%;
    }
    .search-input {
      width: 100%;
      padding: 10px 14px;
      border: 1px solid #ddd;
      border-radius: 10px;
      font-size: 15px;
      background: #fff;
      -webkit-appearance: none;
    }
    .session-list { padding: 0 16px; }
    .session-item {
      display: flex;
      align-items: center;
      background: #fff;
      margin-bottom: 8px;
      border-radius: 10px;
      text-decoration: none;
      color: inherit;
      overflow: hidden;
    }
    .session-link {
      flex: 1;
      padding: 14px 16px;
      text-decoration: none;
      color: inherit;
      min-width: 0;
    }
    .session-title { font-size: 15px; color: #000; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-time { font-size: 13px; color: #888; margin-top: 4px; }
    .session-action-btn {
      background: none;
      border: none;
      padding: 14px 14px;
      font-size: 20px;
      color: #999;
      cursor: pointer;
      flex-shrink: 0;
    }
    .empty { text-align: center; padding: 40px 16px; color: #888; }
    .footer-links { text-align: center; padding: 20px; }
    .footer-links a { color: #007aff; font-size: 14px; }

    /* Modal overlay */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.4);
      z-index: 100;
      justify-content: center;
      align-items: flex-end;
      padding: 0 16px 40px;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: #fff;
      border-radius: 14px;
      width: 100%;
      max-width: 400px;
      overflow: hidden;
    }
    .modal-title {
      padding: 16px;
      font-size: 15px;
      font-weight: 600;
      text-align: center;
      border-bottom: 1px solid #eee;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .modal-btn {
      display: block;
      width: 100%;
      padding: 14px;
      border: none;
      background: none;
      font-size: 16px;
      cursor: pointer;
      text-align: center;
      border-bottom: 1px solid #eee;
    }
    .modal-btn:hover { background: #f5f5f5; }
    .modal-btn.danger { color: #ff3b30; }
    .modal-cancel {
      display: block;
      width: calc(100% - 32px);
      margin: 8px 16px 0;
      padding: 14px;
      border: none;
      background: #fff;
      border-radius: 14px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      color: #007aff;
    }

    /* Rename input inside modal */
    .rename-row {
      display: none;
      padding: 12px 16px;
      gap: 8px;
      border-bottom: 1px solid #eee;
    }
    .rename-row.active { display: flex; }
    .rename-row input {
      flex: 1;
      font-size: 15px;
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 8px;
    }
    .rename-row button {
      padding: 8px 14px;
      background: #007aff;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Agent Brain</h1>
  </div>
  <div class="top-bar">
    <button class="new-chat-btn" onclick="newChat()">+ New Chat</button>
    <input type="text" class="search-input" id="search" placeholder="Search sessions..." oninput="filterSessions()">
  </div>
  <div class="session-list" id="session-list"></div>
  <div class="footer-links"><a href="/runs">View legacy runs</a></div>

  <!-- Action modal -->
  <div class="modal-overlay" id="modal" onclick="closeModal(event)">
    <div>
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-title" id="modal-title"></div>
        <div class="rename-row" id="rename-row">
          <input type="text" id="rename-input" placeholder="New name...">
          <button onclick="doRename()">Save</button>
        </div>
        <button class="modal-btn" onclick="showRename()">Rename</button>
        <button class="modal-btn" onclick="doArchive()">Archive</button>
        <button class="modal-btn danger" onclick="doDelete()">Delete</button>
      </div>
      <button class="modal-cancel" onclick="closeModal()">Cancel</button>
    </div>
  </div>

  <script>
    let allSessions = [];
    let activeSessionId = null;

    async function loadSessions() {
      const resp = await fetch("/api/sessions");
      allSessions = await resp.json();
      filterSessions();
    }

    function filterSessions() {
      const q = (document.getElementById("search").value || "").toLowerCase();
      const list = document.getElementById("session-list");
      const filtered = q ? allSessions.filter(s => s.title.toLowerCase().includes(q)) : allSessions;

      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty">' + (q ? 'No matching sessions' : 'No sessions yet. Start a new chat!') + '</div>';
        return;
      }

      list.innerHTML = filtered.map(s => {
        const ago = timeAgo(s.updated_at);
        return '<div class="session-item">' +
          '<a href="/chat/' + s.session_id + '" class="session-link">' +
            '<div class="session-title">' + esc(s.title) + '</div>' +
            '<div class="session-time">' + ago + '</div>' +
          '</a>' +
          '<button class="session-action-btn" onclick="openModal(\\'' + s.session_id + '\\', \\'' + esc(s.title).replace(/'/g, "\\\\'") + '\\')">&middot;&middot;&middot;</button>' +
        '</div>';
      }).join("");
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

    function openModal(id, title) {
      activeSessionId = id;
      document.getElementById("modal-title").textContent = title;
      document.getElementById("rename-input").value = title;
      document.getElementById("rename-row").classList.remove("active");
      document.getElementById("modal").classList.add("active");
    }

    function closeModal(e) {
      if (e && e.target !== document.getElementById("modal") && e.target !== document.querySelector(".modal-overlay")) {
        if (!e.target.classList.contains("modal-overlay")) return;
      }
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
      loadSessions();
    }

    async function doArchive() {
      if (!activeSessionId) return;
      await fetch("/api/sessions/" + activeSessionId + "/archive", { method: "POST" });
      closeModal();
      loadSessions();
    }

    async function doDelete() {
      if (!activeSessionId) return;
      if (!confirm("Delete this session permanently?")) return;
      await fetch("/api/sessions/" + activeSessionId, { method: "DELETE" });
      closeModal();
      loadSessions();
    }

    async function newChat() {
      const resp = await fetch("/chat/new", { method: "POST" });
      const data = await resp.json();
      window.location.href = "/chat/" + data.session_id;
    }

    loadSessions();
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
  <title>Agent Brain</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, sans-serif;
      background: #f5f5f5;
      height: 100vh;
      height: 100dvh;
      display: flex;
      flex-direction: column;
    }
    .header {
      background: #fff;
      padding: 12px 16px;
      border-bottom: 1px solid #ddd;
      display: flex;
      align-items: center;
      gap: 12px;
      flex-shrink: 0;
    }
    .header a { color: #007aff; text-decoration: none; font-size: 16px; }
    .header .title { font-size: 17px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .copy-btn {
      background: none; border: 1px solid #ccc; border-radius: 8px;
      padding: 6px 10px; font-size: 13px; color: #333; cursor: pointer;
      flex-shrink: 0; white-space: nowrap;
    }
    .copy-btn.copied { background: #e8f5e9; border-color: #4caf50; color: #2e7d32; }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      -webkit-overflow-scrolling: touch;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .msg {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 16px;
      word-wrap: break-word;
      font-size: 15px;
      line-height: 1.4;
    }
    .msg.user {
      background: #007aff;
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
      white-space: pre-wrap;
    }
    .msg.assistant {
      background: #e9e9eb;
      color: #000;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
      white-space: normal;
    }
    .msg.assistant p { margin: 0 0 8px 0; }
    .msg.assistant p:last-child { margin-bottom: 0; }
    .msg.assistant ul, .msg.assistant ol { margin: 0 0 8px 20px; }
    .msg.assistant li { margin-bottom: 2px; }
    .msg.assistant code {
      background: rgba(0,0,0,0.06);
      padding: 1px 5px;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      font-size: 13px;
    }
    .msg.assistant pre {
      background: rgba(0,0,0,0.06);
      padding: 10px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 0 0 8px 0;
      font-size: 13px;
    }
    .msg.assistant pre code { background: none; padding: 0; }
    .msg.assistant h1, .msg.assistant h2, .msg.assistant h3 {
      font-size: 15px;
      font-weight: 600;
      margin: 0 0 6px 0;
    }
    .msg.assistant strong { font-weight: 600; }
    .msg.assistant a { color: #007aff; }
    .msg.thinking {
      background: #e9e9eb;
      color: #888;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
      font-style: italic;
    }
    .tool-block {
      align-self: flex-start;
      max-width: 90%;
      font-size: 13px;
      color: #666;
      background: #f0f0f0;
      padding: 8px 12px;
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, monospace;
      cursor: pointer;
    }
    .tool-block .tool-header { display: flex; gap: 6px; align-items: center; }
    .tool-block .tool-icon { font-size: 12px; }
    .tool-block .tool-output {
      display: none;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid #ddd;
      white-space: pre-wrap;
      max-height: 200px;
      overflow-y: auto;
    }
    .tool-block.expanded .tool-output { display: block; }
    .input-area {
      flex-shrink: 0;
      padding: 8px 12px;
      background: #fff;
      border-top: 1px solid #ddd;
      display: flex;
      gap: 8px;
      align-items: flex-end;
      padding-bottom: max(8px, env(safe-area-inset-bottom));
    }
    .input-area textarea {
      flex: 1;
      font-size: 16px;
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 20px;
      resize: none;
      max-height: 120px;
      min-height: 40px;
      font-family: -apple-system, system-ui, sans-serif;
      line-height: 1.3;
    }
    .input-area button {
      background: #007aff;
      color: #fff;
      border: none;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      font-size: 18px;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .input-area button:disabled { background: #ccc; }
  </style>
</head>
<body>
  <div class="header">
    <a href="/chat">&larr;</a>
    <div class="title" id="chat-title">Chat</div>
    <button class="copy-btn" onclick="copyChat(this)">Copy</button>
  </div>
  <div class="messages" id="messages"></div>
  <div class="input-area">
    <textarea id="input" rows="1" placeholder="Message..." oninput="autoResize(this)"></textarea>
    <button id="send-btn" onclick="sendMessage()">&uarr;</button>
  </div>

  <script>
    const SESSION_ID = "${session_id}";
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send-btn");
    let sending = false;

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

    async function loadSession() {
      try {
        const resp = await fetch("/api/sessions/" + SESSION_ID);
        const data = await resp.json();
        if (data.title) document.getElementById("chat-title").textContent = data.title;
        if (data.messages) renderMessages(data.messages);
      } catch (e) {}
    }

    async function sendMessage() {
      if (sending) return;
      const content = inputEl.value.trim();
      if (!content) return;

      sending = true;
      sendBtn.disabled = true;
      inputEl.value = "";
      inputEl.style.height = "auto";

      addUserMsg(content);
      const thinking = addThinking();

      try {
        const resp = await fetch("/api/sessions/" + SESSION_ID + "/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content })
        });
        const data = await resp.json();
        thinking.remove();

        if (data.error) {
          addAssistantMsg("Error: " + data.error);
        } else if (data.new_messages) {
          renderNewMessages(data.new_messages);
        }
      } catch (err) {
        thinking.remove();
        addAssistantMsg("Error: " + err.message);
      }

      sending = false;
      sendBtn.disabled = false;
      inputEl.focus();
    }

    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
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
