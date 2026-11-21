/**
 * Session Handoff — Comprehensive context compiler
 *
 * Composes a full briefing for a new Claude session by pulling from ALL
 * available context sources in Supabase:
 *   - Project memory (MEMORY.md equivalent)
 *   - Daily logs (recent history)
 *   - Memory topics (architectural knowledge, patterns, etc.)
 *   - Mailbox messages (cross-session communication)
 *   - Orchestrator state (recent tasks and their outcomes)
 *   - Auth services (what integrations are available)
 *   - CLAUDE.md project instructions
 *   - Handoff notes (what the dying session was working on)
 *
 * The goal: a new session should be able to pick up exactly where
 * the old one left off, with all accumulated knowledge intact.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("./db");
const { buildRecentActivitySection } = require("./checkpoint-memory");

const CODEX_CLI_CANDIDATES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/usr/local/bin/codex",
  "/opt/homebrew/bin/codex"
];
const AGENT_BRAIN_BIN_DIR = path.join(__dirname, "..", "bin");

// Curated list of models offered in the spawn model picker. This is the single
// source of truth — add/remove models here and every spawn modal updates.
// The one marked `default: true` is used when a spawn specifies no model.
// Entries use family aliases so they always resolve to the latest of that family.
//
// NOTE: Fable 5 is intentionally omitted. Anthropic gates Fable 5 in Claude Code
// (interactive/terminal) behind separately-purchased usage credits — it is NOT
// covered by the Max subscription for CLI spawns (only in the desktop app). Add
// it back here as { id: "claude-fable-5[1m]", ... } once usage credits are set up.
const SPAWN_MODELS = [
  {
    id: "opus",
    label: "Opus 5",
    description: "Most capable model on your subscription — deep reasoning and complex coding.",
    default: true
  },
  {
    id: "sonnet",
    label: "Sonnet 5",
    description: "Balanced speed and capability — a strong everyday default."
  },
  {
    id: "haiku",
    label: "Haiku 4.5",
    description: "Fastest and lightest — quick, simple tasks."
  }
];

// Default model for newly spawned Claude sessions, derived from the list above
// so there is only one place to change the default.
const SPAWN_CLAUDE_MODEL = (SPAWN_MODELS.find(m => m.default) || SPAWN_MODELS[0]).id;

// Coerce an arbitrary/absent model id to a known-good one, falling back to the
// default. Prevents an unexpected request value from reaching the shell.
function resolveSpawnModel(id) {
  return SPAWN_MODELS.some(m => m.id === id) ? id : SPAWN_CLAUDE_MODEL;
}

function parseMarkdownSections(content = "") {
  const sections = new Map();
  let current = null;
  for (const line of content.split("\n")) {
    const match = line.match(/^##\s+(.+)$/);
    if (match) {
      current = match[1].trim();
      sections.set(current, []);
      continue;
    }
    if (!current) continue;
    sections.get(current).push(line);
  }
  return sections;
}

function summarizeSectionBody(lines = [], { maxBullets = 5, maxChars = 700 } = {}) {
  const bullets = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      bullets.push(line.replace(/^\d+\.\s+/, "- "));
      continue;
    }
    if (/^[A-Z][A-Za-z0-9 _-]{2,40}:$/.test(line)) {
      bullets.push(`- ${line.slice(0, -1)}`);
    }
  }

  if (bullets.length > 0) {
    return bullets.slice(0, maxBullets).join("\n");
  }

  const text = lines.join("\n").trim().replace(/\n{2,}/g, "\n");
  return text.length > maxChars ? text.slice(0, maxChars - 3) + "..." : text;
}

function buildCompactMemory(memory = "") {
  if (!memory) return "";
  const sections = parseMarkdownSections(memory);
  const preferred = ["Architecture", "Key Components", "Recent Changes", "Known Issues", "Next Steps"];
  const parts = [];

  for (const name of preferred) {
    if (!sections.has(name)) continue;
    const summary = summarizeSectionBody(sections.get(name), { maxBullets: name === "Architecture" ? 6 : 5 });
    if (summary) parts.push(`## ${name}\n${summary}`);
  }

  return parts.join("\n\n");
}

function extractHighlightsFromLog(content = "", maxBullets = 4) {
  const bullets = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-*]\s+/.test(line)) {
      bullets.push(line);
    } else if (/^\d+\.\s+/.test(line)) {
      bullets.push(line.replace(/^\d+\.\s+/, "- "));
    }
    if (bullets.length >= maxBullets) break;
  }
  if (bullets.length > 0) return bullets;

  const compact = content.trim().replace(/\s+/g, " ");
  if (!compact) return [];
  return [`- ${compact.slice(0, 220)}${compact.length > 220 ? "..." : ""}`];
}

async function buildRecentLogHighlights(projectDir, limit = 3) {
  const logs = await safeAsync(() => db.listDailyLogs(projectDir));
  if (!logs || logs.length === 0) return "";
  const parts = [];

  for (const log of logs.slice(0, limit)) {
    const content = await safeAsync(() => db.getDailyLog(projectDir, log.date));
    if (!content) continue;
    const bullets = extractHighlightsFromLog(content, 4);
    if (bullets.length === 0) continue;
    parts.push(`### ${log.date}\n${bullets.join("\n")}`);
  }

  return parts.join("\n\n");
}

function buildUnreadMailboxSummary(messages = [], maxItems = 3) {
  if (!messages || messages.length === 0) return "";
  return messages.slice(0, maxItems).map(m => {
    const body = (m.body || "").trim().replace(/\s+/g, " ");
    const snippet = body.length > 220 ? body.slice(0, 217) + "..." : body;
    return `- **${m.subject || "(no subject)"}** (from: ${m.from_session || "unknown"})\n  ${snippet}`;
  }).join("\n\n");
}

function filterStartupMailboxMessages(messages = []) {
  return (messages || []).filter(m => (m.subject || "") !== "Checkpoint Response");
}

function buildStartupContract({ mode, provider }) {
  const providerLabel = provider === "codex" ? "Codex" : "Claude";
  const checkpointSnippet = provider === "codex"
    ? `# AB_PROVIDER and AB_SESSION_ID are already exported for you by the launcher.
# If AB_SESSION_ID is empty, this spawn had no session yet — keep the checkpoint
# id below and recover with \`ab-checkpoint wait-once "$CHECKPOINT_ID"\`, since
# \`consume\` needs AB_SESSION_ID.
CHECKPOINT_ID=$(ab-checkpoint ask "What should I work on?" "Continue previous work" "New task" "Just checking in")
RESPONSE=$(ab-checkpoint wait-once "$CHECKPOINT_ID")
# If RESPONSE is still pending, Agent Brain now owns the long wait for this session.
# When the session resumes, run: ab-checkpoint consume`
    : `Use the agent_brain_checkpoint MCP tool with:
  project: (your project key, pwd with / replaced by -)
  question: "What should I work on?"
  options: ["Continue previous work", "New task", "Just checking in"]

If MCP tools are not available, fall back to curl:
PROJECT_KEY=$(pwd | sed 's|/|-|g')
RESPONSE=$(curl -s --max-time 86410 -X POST http://localhost:3030/api/checkpoints \\
  -H "Content-Type: application/json" \\
  -d "{\"project_dir\":\"$PROJECT_KEY\",\"question\":\"What should I work on?\",\"options\":[\"Continue previous work\",\"New task\",\"Just checking in\"]}")`;

  return `## Startup Contract
This is a ${mode === "handoff" ? "handoff" : "morning refresh"} session for ${providerLabel}.

Before the user gives a concrete task, you may:
- read project memory
- check mailbox
- inspect repo state lightly
- post the startup checkpoint
- wait for the response

Before the user gives a concrete task, you may NOT:
- choose work from "Next Steps" on your own
- start implementing fixes
- treat "ok" or other acknowledgement-only replies as authorization

Use this checkpoint flow:
\`\`\`bash
${checkpointSnippet}
\`\`\`

If the user only acknowledges, post a narrower follow-up checkpoint. Do not start work until the response contains real direction or explicitly says to continue previous work.

For Codex, do not rely on the session itself to hold a 24-hour wait loop. Agent Brain keeps the waiting state and stores the response for later recovery.`;
}

function buildLocalInstructionNote(targetProvider, cwd) {
  const file = targetProvider === "codex" ? "AGENTS.md" : "CLAUDE.md";
  return `## Local Instructions
- Project-specific instructions live in \`${file}\` at ${cwd || "the project root"}.
- Use this briefing as the startup contract for this session.
- Consult the local instruction file after initial direction if you need project-specific reference details.`;
}

// ── Briefing Compiler ────────────────────────────────────────────────────────

/**
 * Compose a comprehensive handoff briefing.
 *
 * @param {object} opts
 * @param {string} opts.projectDir - Supabase project_dir key (e.g. "-Users-yourname-project")
 * @param {string} opts.projectName - Human-readable name (e.g. "Agent Brain")
 * @param {string} opts.cwd - Absolute filesystem path to the project
 * @param {string} opts.fromSessionTitle - Title of the source session
 * @param {string} opts.handoffNotes - What the dying session was working on / next steps
 * @param {object} opts.projectConfig - Full PROJECT_KEYWORDS entry (optional, for repo info)
 * @param {string} opts.targetProvider - Target provider: "claude" or "codex" (default: "claude")
 * @returns {Promise<string>} - The compiled briefing text
 */
async function composeBriefing(opts) {
  const {
    projectDir,
    projectName = "Unknown Project",
    cwd,
    fromSessionTitle = "",
    handoffNotes = "",
    projectConfig = {},
    targetProvider = "claude"
  } = opts;

  const sections = [];

  // ── Header ──
  sections.push(`# Session Handoff Briefing
**Project**: ${projectName}
**Directory**: ${cwd || projectDir}
**Previous Session**: ${fromSessionTitle || "(unknown)"}
**Handoff Time**: ${new Date().toISOString()}

This session is being continued from a previous conversation that ran out of context. The briefing below contains ALL accumulated context to get you back up to speed immediately.`);

  sections.push(buildStartupContract({ mode: "handoff", provider: targetProvider }));

  if (handoffNotes) {
    sections.push(`## Handoff Notes (from previous session)
${handoffNotes}`);
  }

  // Current repo state: branch, recent commits, uncommitted changes
  const gitContext = buildGitContextSection(cwd);
  if (gitContext) {
    sections.push(gitContext);
  }

  // Recent Activity: what's changed since last session
  const recentActivity = await safeAsync(() => buildRecentActivitySection(projectDir, {
    sinceSessionId: opts.fromSessionId
  }));
  if (recentActivity) {
    sections.push(recentActivity);
  }

  const memory = await safeAsync(() => db.getProjectMemory(projectDir));
  const compactMemory = buildCompactMemory(memory || "");
  if (compactMemory) {
    sections.push(`## Project State\n${compactMemory}`);
  }

  const recentHighlights = await buildRecentLogHighlights(projectDir, 3);
  if (recentHighlights) {
    sections.push(`## Recent Session Highlights\n${recentHighlights}`);
  }

  const mailbox = await safeAsync(() =>
    db.readMailbox(projectDir, { unreadOnly: true, limit: 10 })
  );
  const broadcastMail = await safeAsync(() =>
    db.readMailbox("broadcast", { unreadOnly: true, limit: 10 })
  );
  const allMail = [...(mailbox || []), ...(broadcastMail || [])];
  // Deduplicate by id
  const seenIds = new Set();
  const uniqueMail = allMail.filter(m => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });
  const startupMail = filterStartupMailboxMessages(uniqueMail);

  if (startupMail.length > 0) {
    sections.push(`## Unread Mailbox Messages\n${buildUnreadMailboxSummary(startupMail)}`);
  }

  sections.push(buildLocalInstructionNote(targetProvider, cwd));

  if (projectConfig.repo_url) {
    sections.push(`## Project Config
- **Repo**: ${projectConfig.repo_url}
- **Default Branch**: ${projectConfig.default_branch || "main"}
- **CWD**: ${projectConfig.cwd || cwd || "unknown"}`);
  }

  if (targetProvider === "codex") {
    sections.push(`## Codex Checkpoint Protocol
- Use \`ab-checkpoint ask\` to create checkpoints.
- Use \`ab-checkpoint wait-once\` for one immediate short poll if you want to catch a quick reply.
- If the response is still pending, Agent Brain owns the long wait for Codex and preserves the response for later recovery.
- Agent Brain may reactivate the Codex session automatically after a delayed response so it can consume the stored checkpoint reply.
- Resume with \`ab-checkpoint consume\` or \`ab-checkpoint wait-once\` with no id.
- Do not start work until the startup gate is cleared by a concrete task or "Continue previous work".`);
  } else {
    sections.push(`## Claude Checkpoint Protocol
- Use the blocking checkpoint curl inline in the foreground.
- Do not background the blocking checkpoint call.
- All user-facing communication should happen through checkpoints while the session is remote-controlled.
- Do not start work until the startup gate is cleared by a concrete task or "Continue previous work".`);
  }

  return sections.join("\n\n---\n\n");
}

// ── Handoff Record Management ────────────────────────────────────────────────

/**
 * Create a handoff record in Supabase and compose the briefing.
 *
 * @param {object} opts - Same as composeBriefing opts + id
 * @returns {Promise<{id: string, briefing: string}>}
 */
async function createHandoff(opts) {
  const id = `handoff-${Date.now()}`;
  const briefing = await composeBriefing(opts);

  await db.supabase.from("session_handoffs").insert({
    id,
    project_dir: opts.projectDir,
    project_name: opts.projectName || null,
    from_session_title: opts.fromSessionTitle || null,
    handoff_notes: opts.handoffNotes || "",
    briefing,
    status: "pending",
    source_folder_id: opts.sourceFolderId || null
  });

  return { id, briefing };
}

/**
 * Mark a handoff as spawned (new session started).
 */
async function markHandoffSpawned(handoffId, spawnedSessionId) {
  const update = {
    status: "spawned",
    spawned_at: new Date().toISOString()
  };
  if (spawnedSessionId) update.spawned_session_id = spawnedSessionId;
  await db.supabase.from("session_handoffs").update(update).eq("id", handoffId);
}

/**
 * Mark a handoff as dismissed (user chose not to spawn).
 */
async function markHandoffDismissed(handoffId) {
  await db.supabase.from("session_handoffs")
    .update({ status: "dismissed" })
    .eq("id", handoffId);
}

/**
 * Get a handoff record.
 */
async function getHandoff(handoffId) {
  const { data, error } = await db.supabase
    .from("session_handoffs")
    .select("*")
    .eq("id", handoffId)
    .single();
  if (error || !data) return null;
  return data;
}

/**
 * List recent handoffs.
 */
async function listHandoffs(limit = 10) {
  const { data, error } = await db.supabase
    .from("session_handoffs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data;
}

// ── Desktop Spawn ────────────────────────────────────────────────────────────

/**
 * Short initial prompt that points the session at its briefing file.
 * Keeps the lines session-titles.js reads from the first user message (the
 * heading, **Project**, and the first line of ## Your Task) so dashboard
 * titles are unchanged.
 */
function buildBriefingPointer(briefing, briefingFile, { inSystemPrompt = false } = {}) {
  const text = String(briefing || "");
  const lines = [];
  const heading = text.split("\n").find(l => l.trim());
  if (heading && heading.startsWith("# ")) lines.push(heading.trim());
  const project = text.match(/^\*\*Project\*\*:.*$/m);
  if (project) lines.push(project[0].trim());
  const task = text.match(/## Your Task\s+([\s\S]*?)(?:\n## |\n---|\n```|$)/);
  const taskLine = task && task[1].split("\n").map(l => l.trim()).find(Boolean);
  if (taskLine) lines.push("", "## Your Task", taskLine);
  if (inSystemPrompt) {
    lines.push(
      "",
      "Your full Agent Brain handoff briefing is appended to your system prompt (a copy is saved at " + briefingFile + ").",
      "Follow it before doing anything else. It is your startup contract and overrides this summary."
    );
  } else {
    lines.push(
      "",
      `Your full briefing is in this file: ${briefingFile}`,
      "Read the whole file with the Read tool before doing anything else. It is your startup contract and overrides this summary."
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Spawn a new coding session on the Mac desktop with the handoff briefing.
 *
 * Uses osascript to open Terminal.app and run the AI CLI with the briefing.
 *
 * @param {object} opts
 * @param {string} opts.cwd - Working directory for the new session
 * @param {string} opts.briefing - The handoff briefing text
 * @param {string} opts.handoffId - Handoff ID for tracking
 * @param {string} opts.provider - Provider to spawn: "claude" (default) or "codex"
 * @param {string} [opts.model] - Claude model id for this spawn; defaults to Fable. Ignored for Codex.
 * @returns {Promise<{ok: boolean, method: string, provider: string}>}
 */
async function spawnDesktopSession(opts) {
  const { cwd, briefing, handoffId, provider = "claude", model, sessionId } = opts;
  const { execFile } = require("child_process");

  // Write briefing to a temp file
  const tmpDir = path.join(require("os").tmpdir(), "agent-brain-handoffs");
  fs.mkdirSync(tmpDir, { recursive: true });
  const briefingFile = path.join(tmpDir, `${handoffId || "handoff"}.md`);
  fs.writeFileSync(briefingFile, briefing, "utf8");

  // The CLI's initial prompt lands in its argv, so `pkill -f <anything in the
  // briefing>` matches the session itself. On 2026-11-03 an agent ran
  // `pkill -f "api/checkpoints"` to stop its own curl and killed every spawned
  // session at once, because every briefing contains that URL. So argv carries
  // only a short pointer; the full briefing stays in briefingFile.
  const promptFile = path.join(tmpDir, `${handoffId || "handoff"}-prompt.txt`);
  fs.writeFileSync(promptFile, buildBriefingPointer(briefing, briefingFile, { inSystemPrompt: provider === "claude" }), "utf8");

  // Resolve provider CLI paths explicitly so Terminal launch does not depend on shell PATH.
  const cliCommand = resolveCliCommand(provider);

  // Write a launcher script that reads the pointer prompt and passes it as the prompt.
  // The script uses a bash variable to avoid shell escaping issues.
  // For Codex, bypass all approvals for fully autonomous operation.
  // User will receive checkpoints from Codex via Agent Brain for any decisions.
  // For Claude, the briefing goes in via --append-system-prompt-file: the CLI
  // reads it at launch, so it never appears in argv and the session needs no
  // access to the temp dir. (It used to be --add-dir <tmpDir>, but Claude Code
  // 2.1.32x asks a trust question for every added directory — defaulting to
  // "No, exit" — which stalled every spawn until someone pressed a key.)
  const launcherFile = path.join(tmpDir, `${handoffId || "handoff"}-launch.sh`);
  const cliFlags = provider === "codex"
    ? " --dangerously-bypass-approvals-and-sandbox"
    : ` --append-system-prompt-file ${escapeShell(briefingFile)} --model ${escapeShell(resolveSpawnModel(model))}`;
  // Inject long-lived OAuth token so spawned terminals (outside Claude.app) can authenticate.
  // Without this, the standalone CLI reads an expired access token from the keychain
  // and cannot refresh it (refresh is host-managed by Claude.app for in-app sessions).
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const oauthExport = provider === "claude" && oauthToken
    ? `export CLAUDE_CODE_OAUTH_TOKEN=${escapeShell(oauthToken)}\n`
    : "";
  // bin/ab-checkpoint reads these. Without AB_SESSION_ID a Codex session cannot
  // run `ab-checkpoint consume`, which is the whole delayed-response recovery
  // path — it was previously only ever emitted into the briefing PROSE as the
  // literal placeholder "<your session id from briefing>", so agents had to
  // guess AB_PROVIDER and could never consume at all.
  const abEnvExport =
    `export AB_PROVIDER=${escapeShell(provider)}\n` +
    (sessionId ? `export AB_SESSION_ID=${escapeShell(sessionId)}\n` : "");
  // A Terminal.app window spawned via AppleScript inherits launchd's soft file-descriptor
  // limit (256 on macOS), not the raised limit Claude.app sets for its own children. The
  // CLI needs more than that and dies with "possibly due to low max file descriptors".
  // Raise it here, capped at kern.maxfilesperproc, and never let this line fail the launch.
  const launcherScript = `#!/bin/bash
export PATH="${AGENT_BRAIN_BIN_DIR}:${process.env.HOME}/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
FD_LIMIT=$(sysctl -n kern.maxfilesperproc 2>/dev/null || ulimit -Hn 2>/dev/null || echo 10240)
case "$FD_LIMIT" in ''|*[!0-9]*) FD_LIMIT=10240 ;; esac
ulimit -n "$FD_LIMIT" 2>/dev/null || ulimit -n 10240 2>/dev/null || true
${abEnvExport}${oauthExport}cd ${escapeShell(cwd)}
PROMPT=$(cat ${escapeShell(promptFile)})
${provider === "claude" ? `# Claude.app deletes the previous version on update, so a path baked in at
# generation time can be gone by the time this script runs (seen 2026-09-05:
# 2.1.258 vanished within hours). Re-resolve the newest CLI at run time and
# only fall back to the generation-time path if that finds nothing.
CLI=$({ ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/claude.app/Contents/MacOS/claude 2>/dev/null; ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude 2>/dev/null; } | sort -V | tail -1)
[ -x "$CLI" ] || CLI=${escapeShell(cliCommand)}
exec "$CLI"${cliFlags} "$PROMPT"` : `exec ${escapeShell(cliCommand)}${cliFlags} "$PROMPT"`}
`;
  // mode 0o700: this file embeds CLAUDE_CODE_OAUTH_TOKEN in plaintext.
  fs.writeFileSync(launcherFile, launcherScript, { mode: 0o700 });

  const spawnCmd = `bash ${escapeShell(launcherFile)}`;

  // Open a new Terminal.app window and run the AI CLI
  const appleScript = `
    tell application "Terminal"
      activate
      do script "${spawnCmd.replace(/"/g, '\\"')}"
    end tell
  `;

  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", appleScript], { timeout: 10000 }, (err) => {
      if (err) {
        console.error("[handoff] Terminal.app failed, trying iTerm2:", err.message);
        const itermScript = `
          tell application "iTerm2"
            activate
            create window with default profile command "${spawnCmd.replace(/"/g, '\\"')}"
          end tell
        `;
        execFile("/usr/bin/osascript", ["-e", itermScript], { timeout: 10000 }, (err2) => {
          if (err2) {
            reject(new Error(`Failed to open terminal: ${err.message}`));
          } else {
            resolve({ ok: true, method: "iterm2", provider, briefing_file: briefingFile });
          }
        });
      } else {
        resolve({ ok: true, method: "terminal.app", provider, briefing_file: briefingFile });
      }
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function safeAsync(fn) {
  try { return await fn(); } catch (_) { return null; }
}

function safeReadFile(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return null; }
}

function safeGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (_) {
    return null;
  }
}

function buildGitContextSection(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return "";
  const insideRepo = safeGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideRepo !== "true") return "";

  const branch = safeGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const commits = safeGit(cwd, ["log", "-5", "--format=- %h %s (%cr)"]) || "";
  const status = safeGit(cwd, ["status", "--short"]) || "";

  const parts = [`**Branch**: \`${branch}\``];
  if (commits) parts.push(`**Recent commits**:\n${commits}`);

  if (status) {
    const lines = status.split("\n").slice(0, 12);
    const extra = status.split("\n").length - lines.length;
    const body = extra > 0 ? `${lines.join("\n")}\n…and ${extra} more` : lines.join("\n");
    parts.push(`**Uncommitted changes**:\n\`\`\`\n${body}\n\`\`\``);
  } else {
    parts.push(`**Uncommitted changes**: none (working tree clean)`);
  }

  return `## Current Repo State\n${parts.join("\n\n")}`;
}

function escapeShell(str) {
  // Wrap in single quotes, escape any single quotes inside
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

function resolveCliCommand(provider) {
  const candidates = provider === "codex" ? CODEX_CLI_CANDIDATES : getClaudeCliCandidates();
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No ${provider} CLI found in expected locations`);
}

function getClaudeCliCandidates() {
  const baseDir = path.join(process.env.HOME || "", "Library/Application Support/Claude/claude-code");
  const discovered = [];

  // Prefer the newest desktop-managed CLI version. These are kept current by
  // Claude.app and are the only builds that recognize newer models like Fable,
  // so they must win over any (possibly stale) CLI-native install below.
  try {
    const parseVer = (name) => name.split(".").map(n => parseInt(n, 10) || 0);
    const cmpVerDesc = (a, b) => {
      for (let i = 0; i < 3; i++) {
        if ((b.ver[i] || 0) !== (a.ver[i] || 0)) return (b.ver[i] || 0) - (a.ver[i] || 0);
      }
      return 0;
    };
    const versions = fs.readdirSync(baseDir)
      .map(name => ({ name, fullPath: path.join(baseDir, name), ver: parseVer(name) }))
      .filter(entry => {
        try { return fs.statSync(entry.fullPath).isDirectory(); } catch (_) { return false; }
      })
      .sort(cmpVerDesc); // newest version first

    for (const entry of versions) {
      // Desktop-managed installs: binary is inside claude.app bundle.
      // Current layout (<=2.1.158): <version>/claude.app/...
      const appBinary = path.join(entry.fullPath, "claude.app", "Contents", "MacOS", "claude");
      if (fs.existsSync(appBinary)) discovered.push(appBinary);
      // Newer layout (seen 2026-10-27, 2.1.309): Claude.app nests the bundle one
      // level deeper under a per-install hash dir: <version>/<hash>/claude.app/...
      // Without this branch, discovery misses the newest build entirely and
      // silently falls back to the stale npm-global CLI below.
      try {
        for (const sub of fs.readdirSync(entry.fullPath)) {
          const nestedBinary = path.join(entry.fullPath, sub, "claude.app", "Contents", "MacOS", "claude");
          if (fs.existsSync(nestedBinary)) discovered.push(nestedBinary);
        }
      } catch (_) {}
      // Older installs: bare binary at version root
      const bareBinary = path.join(entry.fullPath, "claude");
      if (fs.existsSync(bareBinary)) discovered.push(bareBinary);
    }
  } catch (_) {}

  // CLI-native installs, used only as fallbacks if no desktop-managed build exists.
  discovered.push(path.join(process.env.HOME || "", ".npm-global", "bin", "claude"));
  discovered.push(path.join(process.env.HOME || "", ".local", "bin", "claude"));
  discovered.push("/usr/local/bin/claude", "/opt/homebrew/bin/claude");
  return discovered;
}

// ── Morning Refresh ──────────────────────────────────────────────────────────

/**
 * Compose a morning briefing - richer than regular handoff, emphasizing
 * "fresh start for the day" rather than "continue interrupted work".
 */
async function composeMorningBriefing(opts) {
  const {
    projectDir,
    projectName = "Unknown Project",
    cwd,
    projectConfig = {},
    targetProvider = "claude"
  } = opts;

  const sections = [];
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  // ── Header ──
  sections.push(`# Morning Session — ${today}
**Project**: ${projectName}
**Directory**: ${cwd || projectDir}

Good morning! This is a fresh daily session. Below is the full project context to help you pick up where yesterday left off and plan today's work.`);

  sections.push(buildStartupContract({ mode: "morning_refresh", provider: targetProvider }));

  // Current repo state: branch, recent commits, uncommitted changes
  const gitContext = buildGitContextSection(cwd);
  if (gitContext) {
    sections.push(gitContext);
  }

  // Recent Activity: what's changed in the last 24 hours
  const recentActivity = await safeAsync(() => buildRecentActivitySection(projectDir, {
    sinceTime: new Date(Date.now() - 24 * 60 * 60 * 1000)
  }));
  if (recentActivity) {
    sections.push(recentActivity);
  }

  const memory = await safeAsync(() => db.getProjectMemory(projectDir));
  const compactMemory = buildCompactMemory(memory || "");
  if (compactMemory) {
    sections.push(`## Project State\n${compactMemory}`);
  }

  const recentHighlights = await buildRecentLogHighlights(projectDir, 3);
  if (recentHighlights) {
    sections.push(`## Recent Session Highlights\n${recentHighlights}`);
  }

  const mailbox = await safeAsync(() =>
    db.readMailbox(projectDir, { unreadOnly: true, limit: 10 })
  );
  const broadcastMail = await safeAsync(() =>
    db.readMailbox("broadcast", { unreadOnly: true, limit: 10 })
  );
  const allMail = [...(mailbox || []), ...(broadcastMail || [])];
  const seenIds = new Set();
  const uniqueMail = allMail.filter(m => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });
  const startupMail = filterStartupMailboxMessages(uniqueMail);

  if (startupMail.length > 0) {
    sections.push(`## Unread Messages\n${buildUnreadMailboxSummary(startupMail)}`);
  }

  sections.push(buildLocalInstructionNote(targetProvider, cwd));

  if (projectConfig.repo_url) {
    sections.push(`## Project Config
- **Repo**: ${projectConfig.repo_url}
- **Default Branch**: ${projectConfig.default_branch || "main"}
- **CWD**: ${projectConfig.cwd || cwd || "unknown"}`);
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Create a morning refresh record in Supabase.
 */
async function createMorningRefresh(opts) {
  const briefing = await composeMorningBriefing(opts);
  const id = `refresh-${Date.now()}`;

  const record = {
    id,
    project_dir: opts.projectDir,
    project_name: opts.projectName || null,
    from_session_title: "Morning Refresh",
    handoff_notes: "",
    briefing,
    status: "pending",
    source_folder_id: opts.sourceFolderId || null
  };

  let existing = null;
  let existingError = null;

  ({ data: existing, error: existingError } = await db.supabase
    .from("session_handoffs")
    .select("id, created_at")
    .eq("status", "pending")
    .eq("project_dir", opts.projectDir)
    .eq("is_morning_refresh", true)
    .order("created_at", { ascending: false }));

  if (existingError && existingError.message?.includes("is_morning_refresh")) {
    const fallback = await db.supabase
      .from("session_handoffs")
      .select("id, created_at")
      .eq("status", "pending")
      .eq("project_dir", opts.projectDir)
      .eq("from_session_title", "Morning Refresh")
      .order("created_at", { ascending: false });
    existing = fallback.data;
    existingError = fallback.error;
  }

  if (existingError) {
    console.error("[morning-refresh] Existing refresh lookup error:", existingError.message);
    throw new Error(existingError.message);
  }

  if (existing && existing.length > 0) {
    const [keeper, ...duplicates] = existing;

    const updateRecord = {
      project_name: record.project_name,
      handoff_notes: record.handoff_notes,
      briefing: record.briefing,
      source_folder_id: record.source_folder_id,
      status: "pending"
    };

    let updateError = null;
    const { error: err1 } = await db.supabase
      .from("session_handoffs")
      .update({ ...updateRecord, is_morning_refresh: true })
      .eq("id", keeper.id);

    if (err1 && err1.message?.includes("is_morning_refresh")) {
      const { error: err2 } = await db.supabase
        .from("session_handoffs")
        .update(updateRecord)
        .eq("id", keeper.id);
      updateError = err2;
    } else {
      updateError = err1;
    }

    if (updateError) {
      console.error("[morning-refresh] Update error:", updateError.message);
      throw new Error(updateError.message);
    }

    for (const dup of duplicates) {
      await db.supabase
        .from("session_handoffs")
        .update({ status: "dismissed" })
        .eq("id", dup.id);
    }

    return { id: keeper.id, briefing, reused: true };
  }

  // Try to insert with is_morning_refresh column
  record.is_morning_refresh = true;
  let { error } = await db.supabase.from("session_handoffs").insert(record);

  // If column doesn't exist, retry without it
  if (error && error.message?.includes("is_morning_refresh")) {
    delete record.is_morning_refresh;
    const result = await db.supabase.from("session_handoffs").insert(record);
    error = result.error;
  }

  if (error) {
    console.error("[morning-refresh] Insert error:", error.message);
    throw new Error(error.message);
  }

  return { id, briefing };
}

/**
 * Get projects that need morning refresh.
 * Criteria:
 * - Has activity in last 24 hours
 * - Activity is NOT just a previous morning refresh
 * - No currently active session
 */
async function getProjectsNeedingRefresh() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Get sessions with recent activity
  const { data: sessions } = await db.supabase
    .from("sessions")
    .select("session_id, title, cc_project_dir, updated_at, archived")
    .gte("updated_at", cutoff)
    .eq("archived", false);

  if (!sessions || sessions.length === 0) return [];

  // Get recent handoffs to exclude refresh-only activity
  const { data: recentHandoffs } = await db.supabase
    .from("session_handoffs")
    .select("project_dir, created_at, is_morning_refresh")
    .gte("created_at", cutoff)
    .eq("is_morning_refresh", true);

  const latestRefreshByProject = new Map();
  if (recentHandoffs) {
    for (const h of recentHandoffs) {
      if (!h.project_dir || !h.created_at) continue;
      const existing = latestRefreshByProject.get(h.project_dir);
      const createdAt = new Date(h.created_at).getTime();
      if (!existing || createdAt > existing) {
        latestRefreshByProject.set(h.project_dir, createdAt);
      }
    }
  }

  const runtimeEvents = await db.queryEvents({
    since: cutoff,
    type: "session_runtime_state",
    limit: 500
  });
  const latestRuntimeStateBySession = new Map();
  for (const event of runtimeEvents || []) {
    if (!event.session_id || latestRuntimeStateBySession.has(event.session_id)) continue;
    latestRuntimeStateBySession.set(event.session_id, event.data || {});
  }

  const folders = await db.loadFolders();

  // Group sessions by project
  const projectSessions = {};
  for (const s of sessions) {
    if (!s.cc_project_dir) continue;
    if (!projectSessions[s.cc_project_dir]) {
      projectSessions[s.cc_project_dir] = [];
    }
    projectSessions[s.cc_project_dir].push(s);
  }

  // Find projects with real work (not just refresh)
  const projectsToRefresh = [];
  for (const [projectDir, sessionsInProject] of Object.entries(projectSessions)) {
    const nonRefreshSessions = sessionsInProject.filter(s => !s.title?.startsWith("Morning Refresh"));
    if (nonRefreshSessions.length === 0) continue;

    const latestNonRefreshSession = nonRefreshSessions
      .slice()
      .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))[0];

    const latestRefreshAt = latestRefreshByProject.get(projectDir);
    if (latestRefreshAt) {
      const latestNonRefreshAt = new Date(latestNonRefreshSession.updated_at).getTime();
      if (!Number.isNaN(latestNonRefreshAt) && latestNonRefreshAt <= latestRefreshAt) {
        continue;
      }
    }

    const latestRuntime = latestRuntimeStateBySession.get(latestNonRefreshSession.session_id);
    if (latestRuntime) {
      const runtimeState = latestRuntime.state;
      if (runtimeState === "waiting_on_checkpoint" || runtimeState === "awaiting_initial_direction" || runtimeState === "executing") {
        continue;
      }
    }

    const latestSession = latestNonRefreshSession;

    const latestAgeMs = Date.now() - new Date(latestSession.updated_at).getTime();

    // Do not suggest a refresh if the project already has an active or very recent session.
    if (latestAgeMs < 6 * 60 * 60 * 1000) continue;

    // Find folder for this session
    const folder = folders.find(f => f.session_ids.includes(latestSession.session_id));

    const normalizedName = (latestSession.title || "").toLowerCase();
    const isLowSignalProject =
      projectDir === process.env.HOME ||
      projectDir === path.join(process.env.HOME || "", "Documents").replace(/\//g, "-") ||
      normalizedName.includes("test codex") ||
      normalizedName.includes("test this is a test") ||
      normalizedName.startsWith("# test");

    if (isLowSignalProject && !folder) continue;

    projectsToRefresh.push({
      projectDir,
      projectName: latestSession.title?.replace(/ - \d{4}-\d{2}-\d{2}$/, "") || projectDir,
      latestSession,
      folderId: folder?.id || null,
      folderName: folder?.name || null,
      lastActivity: latestSession.updated_at
    });
  }

  return projectsToRefresh;
}

/**
 * Get pending morning refreshes.
 */
async function getPendingMorningRefreshes() {
  // First try with is_morning_refresh column (if it exists)
  let { data, error } = await db.supabase
    .from("session_handoffs")
    .select("*")
    .eq("status", "pending")
    .eq("is_morning_refresh", true)
    .order("created_at", { ascending: false });

  // If column doesn't exist, fall back to checking from_session_title
  if (error && error.message?.includes("is_morning_refresh")) {
    const result = await db.supabase
      .from("session_handoffs")
      .select("*")
      .eq("status", "pending")
      .eq("from_session_title", "Morning Refresh")
      .order("created_at", { ascending: false });
    data = result.data;
    error = result.error;
  }

  if (error) return [];

  const seenProjects = new Set();
  const deduped = [];
  for (const row of (data || [])) {
    if (!row.project_dir) continue;
    if (seenProjects.has(row.project_dir)) continue;
    seenProjects.add(row.project_dir);
    deduped.push(row);
  }

  return deduped;
}

module.exports = {
  composeBriefing,
  createHandoff,
  markHandoffSpawned,
  markHandoffDismissed,
  getHandoff,
  listHandoffs,
  spawnDesktopSession,
  buildBriefingPointer,
  composeMorningBriefing,
  createMorningRefresh,
  getProjectsNeedingRefresh,
  getPendingMorningRefreshes,
  SPAWN_MODELS,
  SPAWN_CLAUDE_MODEL,
  resolveSpawnModel
};
