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
const db = require("./db");

const CODEX_CLI_CANDIDATES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/usr/local/bin/codex",
  "/opt/homebrew/bin/codex"
];

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

  // ── Handoff Notes (most important — what was being worked on) ──
  if (handoffNotes) {
    sections.push(`## Handoff Notes (from previous session)
${handoffNotes}`);
  }

  // ── Project Memory ──
  const memory = await safeAsync(() => db.getProjectMemory(projectDir));
  if (memory) {
    sections.push(`## Project Memory
${memory}`);
  }

  // ── Memory Topics ──
  const topics = await safeAsync(() => db.listTopics(projectDir));
  if (topics && topics.length > 0) {
    const topicContents = [];
    for (const topic of topics) {
      const content = await safeAsync(() => db.getTopic(projectDir, topic.name));
      if (content) {
        topicContents.push(`### Topic: ${topic.name}\n${content}`);
      }
    }
    if (topicContents.length > 0) {
      sections.push(`## Knowledge Base (Memory Topics)\n${topicContents.join("\n\n")}`);
    }
  }

  // ── Recent Daily Logs (last 5 days) ──
  const logs = await safeAsync(() => db.listDailyLogs(projectDir));
  if (logs && logs.length > 0) {
    const recentLogs = logs.slice(0, 5);
    const logContents = [];
    for (const log of recentLogs) {
      const content = await safeAsync(() => db.getDailyLog(projectDir, log.date));
      if (content) {
        logContents.push(`### ${log.date}\n${content}`);
      }
    }
    if (logContents.length > 0) {
      sections.push(`## Recent Daily Logs\n${logContents.join("\n\n")}`);
    }
  }

  // ── Unread Mailbox ──
  const mailbox = await safeAsync(() =>
    db.readMailbox(projectDir, { unreadOnly: true, limit: 10 })
  );
  // Also check broadcast
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

  if (uniqueMail.length > 0) {
    const mailLines = uniqueMail.map(m =>
      `- **${m.subject || "(no subject)"}** (from: ${m.from_session || "unknown"}, ${m.ts})\n  ${(m.body || "").slice(0, 500)}`
    );
    sections.push(`## Unread Mailbox Messages\n${mailLines.join("\n\n")}`);
  }

  // ── Recent Orchestrator Tasks ──
  const orch = await safeAsync(() => db.loadOrchestrator());
  if (orch && orch.tasks && orch.tasks.length > 0) {
    // Show recent tasks (last 10), prioritize same project
    const projectTasks = orch.tasks
      .filter(t => t.project_name === projectName || t.project_dir === projectDir)
      .slice(-10);
    const otherTasks = orch.tasks
      .filter(t => t.project_name !== projectName && t.project_dir !== projectDir)
      .slice(-5);

    const taskLines = [];
    for (const t of [...projectTasks, ...otherTasks]) {
      taskLines.push(`- **${t.description}** [${t.status}] (${t.project_name})${t.git_branch ? ` → branch: \`${t.git_branch}\`` : ""}${t.error ? ` ⚠ ${t.error}` : ""}`);
    }
    if (taskLines.length > 0) {
      sections.push(`## Recent Orchestrator Tasks\n${taskLines.join("\n")}`);
    }
  }

  // ── Available Auth Services ──
  const authServices = await safeAsync(async () => {
    const { data } = await db.supabase
      .from("auth_services")
      .select("service, display_name, auto_approve, expires_at")
      .order("service");
    return data;
  });
  if (authServices && authServices.length > 0) {
    const svcLines = authServices.map(s =>
      `- **${s.display_name}** (\`${s.service}\`) — auto-approve: ${s.auto_approve ? "yes" : "no"}${s.expires_at ? `, expires: ${s.expires_at}` : ""}`
    );
    sections.push(`## Available Auth Services
These services are configured in the auth broker. Fly.io agents can request tokens for these.
${svcLines.join("\n")}`);
  }

  // ── Project Instructions (provider-specific instruction file) ──
  if (cwd) {
    const instructionFile = targetProvider === "codex" ? "AGENTS.md" : "CLAUDE.md";
    const instructionPath = path.join(cwd, instructionFile);
    const instructions = safeReadFile(instructionPath);
    if (instructions) {
      sections.push(`## Project Instructions (${instructionFile})
${instructions}`);
    }
  }

  // ── Project Config ──
  if (projectConfig.repo_url) {
    sections.push(`## Project Config
- **Repo**: ${projectConfig.repo_url}
- **Default Branch**: ${projectConfig.default_branch || "main"}
- **CWD**: ${projectConfig.cwd || cwd || "unknown"}`);
  }

  // ── Closing instructions: Atomic Cycle Protocol ──
  // Different patterns for Claude (blocking) vs Codex (polling)
  if (targetProvider === "codex") {
    sections.push(`## CRITICAL: Atomic Cycle Protocol for Remote-Controlled Sessions (Codex Persistent Wait Mode)

**THIS IS A REMOTE-CONTROLLED SESSION.** The user is NOT at the computer. They interact with you ONLY through checkpoints on their phone.

### Core Rule

**Never end your turn while a checkpoint is still pending.**

If the current checkpoint status is \`pending\`, your job is to keep calling \`/wait\`.
- \`pending\` does NOT mean "report status"
- \`pending\` means **continue waiting**

If you stop early, you will miss the user's response and break the session.

### User Communication Rule

In remote-controlled mode, do NOT use normal chat replies for user-facing communication.
All user-visible communication must happen through checkpoints.

This includes:
- Questions
- Status updates
- Task completions
- Errors
- Findings
- Requests for clarification

### State Machine

You operate in two states:

**WAITING**
- You have created a checkpoint
- You must call \`/wait\` repeatedly until it returns \`status: "responded"\`

**EXECUTING**
- \`/wait\` returned \`status: "responded"\`
- Read \`response\` and \`protocol.user_instruction\`
- Perform the work completely
- When done, create a new checkpoint with the result
- Return to WAITING

### Checkpoint Pattern

**Step 1: Create checkpoint**
\`\`\`bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
RESULT=$(jq -n --arg pd "$PROJECT_KEY" --arg q "Your message here" \\
  '{project_dir: $pd, question: $q, options: ["Option 1", "Option 2", "Other"]}' | \\
  curl -s -X POST "http://localhost:3030/api/checkpoints?blocking=false" \\
    -H "Content-Type: application/json" --data-binary @-)
CHECKPOINT_ID=$(echo "$RESULT" | jq -r '.checkpoint_id')
echo "$CHECKPOINT_ID" > /tmp/agent-brain-checkpoint-id
echo "Created checkpoint: $CHECKPOINT_ID"
\`\`\`

Always save the checkpoint_id immediately so the session can recover if interrupted.

**Step 2: Wait for response**

Use 30-second waits to reduce tool-call churn:
\`\`\`bash
curl -s "http://localhost:3030/api/checkpoints/CHECKPOINT_ID/wait?timeout=30"
\`\`\`

Returns:
- \`{"status":"pending", ...}\` → call /wait again
- \`{"status":"responded", "response":"...", "protocol": {...}}\` → switch to EXECUTING

### Anti-Drift Rule

After every \`/wait\` result with \`status: "pending"\`, remind yourself:

> **Pending means continue. Do NOT end the turn.**
> **Pending means call /wait again.**

You may send yourself this exact reminder in commentary if needed:
- "Checkpoint still pending. Pending means continue. Do NOT end turn. Call /wait again."

### Minimum Waiting Requirement

To prevent drift, you must keep polling for at least one of these minimums before considering any fallback:
- **10 /wait calls**, or
- **5 minutes of waiting**

With 30-second waits, that normally means staying in the wait cycle for about 5 minutes.

**Before that threshold, do not stop just because the checkpoint is still pending.**

### Strong Prohibition

The following behavior is **PROHIBITED**:
- Ending the turn while the checkpoint is still pending
- Sending a final "still waiting" chat reply
- Treating repeated pending results as a reason to stop
- Replacing the wait loop with a summary/status message

If the checkpoint is pending, the correct action is always:
1. Keep the checkpoint_id
2. Call \`/wait?timeout=30\` again

### No Shell Loops

Do NOT use shell loops. Each /wait call must be a separate tool invocation.

**WRONG:**
\`\`\`bash
while true; do curl ...; done
\`\`\`

**RIGHT:**
- One tool call to \`/wait?timeout=30\`
- If pending, another tool call to \`/wait?timeout=30\`
- Repeat until responded

### Fallback Behavior

**If the platform appears likely to force the turn to end:**

Before the turn ends, do all of the following:
1. Save the checkpoint id somewhere durable:
   \`echo "ckpt-..." > /tmp/agent-brain-checkpoint-id\`
2. Save brief recovery state to project memory or daily log:
   - checkpoint id
   - that you were in WAITING
   - that no user response had been received yet
3. Do NOT mark the task complete
4. Do NOT claim the user failed to respond unless /wait actually returned a timeout/final state from the server

**If context window pressure becomes a problem:**

Do NOT summarize and stop waiting. Instead:
1. Save the checkpoint_id
2. Save a minimal recovery note to memory
3. Keep any commentary extremely short
4. Resume waiting from the saved checkpoint_id in the next turn/session

**If a later session resumes this handoff:**

1. Read the saved checkpoint_id
2. Call \`/wait?timeout=30\`
3. If pending, continue polling
4. If responded, execute the instruction

### Atomic Cycle

1. Create checkpoint with \`?blocking=false\`
2. Save checkpoint_id immediately
3. Call \`/wait?timeout=30\`
4. If pending, remind yourself: "Pending means continue. Do NOT end turn."
5. Call \`/wait?timeout=30\` again
6. Repeat until \`status: "responded"\`
7. Execute the user's instruction completely
8. Post a new checkpoint with results
9. Return to waiting

### First Action After Reading This Briefing

1. Read the handoff context (memory, logs, notes above)
2. Check unread mailbox messages
3. Post a checkpoint asking what to focus on
4. Save the returned checkpoint_id to \`/tmp/agent-brain-checkpoint-id\`
5. Call \`/wait?timeout=30\`
6. If it returns pending, keep calling \`/wait?timeout=30\`
7. **Do NOT end the turn while still pending**

### One-Line Reminder

**If checkpoint status is pending: do not report status, do not stop, do not finalize. Save the checkpoint id and call /wait again.**`);
  } else {
    // Claude Code - blocking approach
    sections.push(`## CRITICAL: Atomic Cycle Protocol for Remote-Controlled Sessions

**THIS IS A REMOTE-CONTROLLED SESSION.** The user is NOT at the computer. They will interact with you ONLY through checkpoints on their phone.

### The Atomic Cycle State Machine
You operate in two states:

**BLOCKING** — Waiting for user input via checkpoint
- You have posted a checkpoint and are waiting for the response
- The curl command blocks until the user responds (up to 4 hours)
- Do NOT send any chat responses while blocking

**EXECUTING** — Performing the user's requested work
- You received a checkpoint response with \`protocol.your_state: "EXECUTING"\`
- Execute the user's instruction completely
- When done, POST a new checkpoint with your results
- Return to BLOCKING state

### The Golden Rule
**In remote-controlled mode, never send a final chat response to the user. User-visible communication must occur via checkpoints only.**

This means:
- Questions → checkpoint
- Status updates → checkpoint
- Task completions → checkpoint
- Errors → checkpoint
- Findings → checkpoint

### Checkpoint Pattern (uses jq for safe JSON)
\`\`\`bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
RESPONSE=$(jq -n --arg pd "$PROJECT_KEY" --arg q "Your message here" \\
  '{project_dir: $pd, question: $q, options: ["Option 1", "Option 2", "Other"]}' | \\
  curl -s --max-time 14410 -X POST http://localhost:3030/api/checkpoints \\
    -H "Content-Type: application/json" --data-binary @-)
echo "$RESPONSE"
\`\`\`

**CRITICAL: Run this curl INLINE (foreground), NOT in background. The command blocks until the user responds.**

### The Atomic Cycle
1. **POST** checkpoint (enter BLOCKING state)
2. **WAIT** for user response (curl blocks)
3. **RECEIVE** response with \`protocol.your_state: "EXECUTING"\`
4. **EXECUTE** the user's instruction
5. **POST** new checkpoint with results (return to step 1)

**WRONG:** Receiving response → printing "done, waiting" → going idle
**RIGHT:** Receiving response → executing work → posting checkpoint → blocking

### First Action After Reading This Briefing
1. Read context above (memory, logs, handoff notes)
2. Check for unread mailbox messages
3. POST A CHECKPOINT asking what to focus on
4. WAIT for response before doing ANY work

### Key Points
- The user responds from their phone — checkpoints wait up to 4 hours
- The response includes \`protocol\` fields telling you your state and required action
- Project memory contains accumulated learnings — use them
- Before session ends, flush learnings to project memory and daily logs`);
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
 * Spawn a new coding session on the Mac desktop with the handoff briefing.
 *
 * Uses osascript to open Terminal.app and run the AI CLI with the briefing.
 *
 * @param {object} opts
 * @param {string} opts.cwd - Working directory for the new session
 * @param {string} opts.briefing - The handoff briefing text
 * @param {string} opts.handoffId - Handoff ID for tracking
 * @param {string} opts.provider - Provider to spawn: "claude" (default) or "codex"
 * @returns {Promise<{ok: boolean, method: string, provider: string}>}
 */
async function spawnDesktopSession(opts) {
  const { cwd, briefing, handoffId, provider = "claude" } = opts;
  const { execFile } = require("child_process");

  // Write briefing to a temp file
  const tmpDir = path.join(require("os").tmpdir(), "agent-brain-handoffs");
  fs.mkdirSync(tmpDir, { recursive: true });
  const briefingFile = path.join(tmpDir, `${handoffId || "handoff"}.md`);
  fs.writeFileSync(briefingFile, briefing, "utf8");

  // Resolve provider CLI paths explicitly so Terminal launch does not depend on shell PATH.
  const cliCommand = resolveCliCommand(provider);

  // Write a launcher script that reads the briefing and passes it as the prompt.
  // macOS ARG_MAX is ~1MB; our briefings are ~12-20KB so this is safe.
  // The script uses a bash variable to avoid shell escaping issues.
  // For Codex, bypass all approvals for fully autonomous operation.
  // User will receive checkpoints from Codex via Agent Brain for any decisions.
  const launcherFile = path.join(tmpDir, `${handoffId || "handoff"}-launch.sh`);
  const cliFlags = provider === "codex" ? " --dangerously-bypass-approvals-and-sandbox" : "";
  const launcherScript = `#!/bin/bash
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd ${escapeShell(cwd)}
PROMPT=$(cat ${escapeShell(briefingFile)})
exec ${escapeShell(cliCommand)}${cliFlags} "$PROMPT"
`;
  fs.writeFileSync(launcherFile, launcherScript, { mode: 0o755 });

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

  try {
    const versions = fs.readdirSync(baseDir)
      .map(name => ({
        name,
        fullPath: path.join(baseDir, name),
        stat: fs.statSync(path.join(baseDir, name))
      }))
      .filter(entry => entry.stat.isDirectory())
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .map(entry => path.join(entry.fullPath, "claude"));
    discovered.push(...versions);
  } catch (_) {}

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

  // ── Project Memory ──
  const memory = await safeAsync(() => db.getProjectMemory(projectDir));
  if (memory) {
    sections.push(`## Project Memory
${memory}`);
  }

  // ── Yesterday's Work (most recent daily log) ──
  const logs = await safeAsync(() => db.listDailyLogs(projectDir));
  if (logs && logs.length > 0) {
    const recentLogs = logs.slice(0, 3);
    const logContents = [];
    for (const log of recentLogs) {
      const content = await safeAsync(() => db.getDailyLog(projectDir, log.date));
      if (content) {
        logContents.push(`### ${log.date}\n${content}`);
      }
    }
    if (logContents.length > 0) {
      sections.push(`## Recent Session Logs\n${logContents.join("\n\n")}`);
    }
  }

  // ── Memory Topics (knowledge base) ──
  const topics = await safeAsync(() => db.listTopics(projectDir));
  if (topics && topics.length > 0) {
    const topicContents = [];
    for (const topic of topics) {
      const content = await safeAsync(() => db.getTopic(projectDir, topic.name));
      if (content) {
        topicContents.push(`### ${topic.name}\n${content}`);
      }
    }
    if (topicContents.length > 0) {
      sections.push(`## Knowledge Base\n${topicContents.join("\n\n")}`);
    }
  }

  // ── Unread Mailbox ──
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

  if (uniqueMail.length > 0) {
    const mailLines = uniqueMail.map(m =>
      `- **${m.subject || "(no subject)"}** (from: ${m.from_session || "unknown"})\n  ${(m.body || "").slice(0, 500)}`
    );
    sections.push(`## Unread Messages\n${mailLines.join("\n\n")}`);
  }

  // ── Project Instructions (provider-specific instruction file) ──
  if (cwd) {
    const instructionFile = targetProvider === "codex" ? "AGENTS.md" : "CLAUDE.md";
    const instructionPath = path.join(cwd, instructionFile);
    const instructions = safeReadFile(instructionPath);
    if (instructions) {
      sections.push(`## Project Instructions (${instructionFile})\n${instructions}`);
    }
  }

  // ── Project Config ──
  if (projectConfig.repo_url) {
    sections.push(`## Project Config
- **Repo**: ${projectConfig.repo_url}
- **Default Branch**: ${projectConfig.default_branch || "main"}
- **CWD**: ${projectConfig.cwd || cwd || "unknown"}`);
  }

  // ── Closing instructions ──
  sections.push(`## Today's Session Instructions
This is a fresh daily session. Your goals:

1. **Review the project memory and recent logs** to understand current state
2. **Check for unread messages** that may contain new priorities
3. **Post a checkpoint** to ask what the user wants to focus on today:

\`\`\`bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
curl -s --max-time 310 -X POST http://localhost:3030/api/checkpoints \\
  -H "Content-Type: application/json" \\
  -d '{"project_dir": "'$PROJECT_KEY'", "question": "Good morning! I reviewed the project state. What would you like to focus on today?", "options": ["Continue from yesterday", "New priority", "Just checking in"]}'
\`\`\`

4. **Before ending**, save your work to project memory and daily log
5. **NEVER go idle** — always post a checkpoint asking what's next`);

  return sections.join("\n\n---\n\n");
}

/**
 * Create a morning refresh record in Supabase.
 */
async function createMorningRefresh(opts) {
  const id = `refresh-${Date.now()}`;
  const briefing = await composeMorningBriefing(opts);

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

  const refreshOnlyProjects = new Set();
  if (recentHandoffs) {
    for (const h of recentHandoffs) {
      // If the only activity was a morning refresh, skip
      refreshOnlyProjects.add(h.project_dir);
    }
  }

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
    // Skip if the only activity was a refresh
    if (refreshOnlyProjects.has(projectDir)) {
      // Check if there's real session activity after the refresh
      const hasRealActivity = sessionsInProject.some(s => {
        return !s.title?.startsWith("Morning Refresh");
      });
      if (!hasRealActivity) continue;
    }

    // Find the most recent session
    const latestSession = sessionsInProject.sort((a, b) =>
      new Date(b.updated_at) - new Date(a.updated_at)
    )[0];

    // Find folder for this session
    const folders = await db.loadFolders();
    const folder = folders.find(f => f.session_ids.includes(latestSession.session_id));

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
  return data;
}

module.exports = {
  composeBriefing,
  createHandoff,
  markHandoffSpawned,
  markHandoffDismissed,
  getHandoff,
  listHandoffs,
  spawnDesktopSession,
  composeMorningBriefing,
  createMorningRefresh,
  getProjectsNeedingRefresh,
  getPendingMorningRefreshes
};
