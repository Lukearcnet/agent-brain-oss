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

const RUNS_DIR = path.join(__dirname, "runs");
if (!fs.existsSync(RUNS_DIR)) fs.mkdirSync(RUNS_DIR);

const HOME = os.homedir();

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

  // Expand ~ and ~/ to HOME
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = path.join(HOME, p.slice(2));

  // Treat relative paths as relative to HOME (not process.cwd)
  if (!path.isAbsolute(p)) p = path.join(HOME, p);

  const resolved = path.resolve(p);

  // Allow HOME itself or anything under HOME/
  if (resolved !== HOME && !resolved.startsWith(HOME + path.sep)) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

function readFileTool({ file_path, max_chars = 12000 }) {
  const p = ensurePathInHome(file_path);
  const data = fs.readFileSync(p, "utf8");
  return data.slice(0, max_chars);
}

const ALLOWED_COMMANDS = new Set([
  "ls",
  "pwd",
  "whoami",
  "git",
  "node",
  "npm",
  "python3",
  "claude"
]);

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
        if (err) {
          return reject(new Error(stderr || err.message));
        }
        resolve(stdout + (stderr ? "\n" + stderr : ""));
      }
    );
  });
}

app.get("/", (_req, res) => {
  res.type("html").send(`
  <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Agent Brain</title>
      <style>
        body { font-family: -apple-system, system-ui, sans-serif; margin: 24px; max-width: 720px; }
        textarea { width: 100%; min-height: 140px; font-size: 16px; padding: 12px; }
        button { font-size: 16px; padding: 10px 14px; margin-top: 10px; }
        pre { background: #f6f6f6; padding: 12px; overflow: auto; }
      </style>
    </head>
    <body>
      <h2>Agent Brain</h2>
      <p><a href="/runs">View recent runs</a></p>
      <textarea id="task" placeholder="e.g. Run git status in ~/agent-brain and summarize changes"></textarea>
      <br />
      <button onclick="runTask()">Run</button>
      <h3>Result</h3>
      <pre id="out"></pre>

      <script>
        async function runTask() {
          const task = document.getElementById("task").value.trim();
          if (!task) return;

          document.getElementById("out").textContent = "Running...";

          const resp = await fetch("/run", {
            method: "POST",
            headers: {"Content-Type":"application/json"},
            body: JSON.stringify({ task })
          });

          const data = await resp.json();
          let output = "";
          if (data.run_id) output += "Run: " + data.run_id + "\\n\\n";
          output += data.answer || data.error || JSON.stringify(data, null, 2);
          document.getElementById("out").textContent = output;
        }
      </script>
    </body>
  </html>
  `);
});

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
        <p><a href="/">← New Task</a></p>
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
        <p><a href="/runs">← Back</a></p>
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

  const tools = [
    {
      type: "function",
      function: {
        name: "run_command",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            args: { type: "array", items: { type: "string" } },
            cwd: { type: "string" }
          },
          required: ["command"]
        }
      }
    }
  ];

  let messages = [
    { role: "system", content: "You are running on Luke's Mac. Use tools when needed." },
    { role: "user", content: task }
  ];

  try {
    const resp = await client.chat.completions.create({
      model: "gpt-4.1",
      messages,
      tools,
      tool_choice: "auto"
    });

    const msg = resp.choices[0].message;

    if (msg.tool_calls) {
      const call = msg.tool_calls[0];
      const args = JSON.parse(call.function.arguments);
      const output = await runCommandTool(args);

      const followup = await client.chat.completions.create({
        model: "gpt-4.1",
        messages: [
          ...messages,
          msg,
          { role: "tool", tool_call_id: call.id, content: output }
        ]
      });

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

const PORT = process.env.PORT || 3030;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agent Brain running on http://localhost:${PORT}`);
});
