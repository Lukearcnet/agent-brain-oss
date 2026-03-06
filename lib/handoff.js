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
 * @returns {Promise<string>} - The compiled briefing text
 */
async function composeBriefing(opts) {
  const {
    projectDir,
    projectName = "Unknown Project",
    cwd,
    fromSessionTitle = "",
    handoffNotes = "",
    projectConfig = {}
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

  // ── CLAUDE.md (project instructions) ──
  if (cwd) {
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    const claudeMd = safeReadFile(claudeMdPath);
    if (claudeMd) {
      sections.push(`## Project Instructions (CLAUDE.md)
${claudeMd}`);
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
  sections.push(`## Instructions
You are continuing work that a previous session started. Review the handoff notes above to understand what was being worked on, then pick up where the previous session left off.

Key points:
- The project memory and knowledge base above contain accumulated learnings — use them
- Check the daily logs for recent session summaries
- If there are unread mailbox messages, process them
- Before YOUR session ends, flush your learnings back to project memory and daily logs
- This project uses Agent Brain (http://localhost:3030) for persistent memory — see CLAUDE.md for API details

Continue with the work described in the handoff notes. Do not ask the user what to do — you have enough context to proceed.`);

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
 * Spawn a new Claude Code session on the Mac desktop with the handoff briefing.
 *
 * Uses osascript to open Terminal.app and run `claude` with the briefing
 * piped via --resume flag pointing at a temp file containing the prompt.
 *
 * @param {object} opts
 * @param {string} opts.cwd - Working directory for the new session
 * @param {string} opts.briefing - The handoff briefing text
 * @param {string} opts.handoffId - Handoff ID for tracking
 * @returns {Promise<{ok: boolean, method: string}>}
 */
async function spawnDesktopSession(opts) {
  const { cwd, briefing, handoffId } = opts;
  const { execFile } = require("child_process");

  // Write briefing to a temp file
  const tmpDir = path.join(require("os").tmpdir(), "agent-brain-handoffs");
  fs.mkdirSync(tmpDir, { recursive: true });
  const briefingFile = path.join(tmpDir, `${handoffId || "handoff"}.md`);
  fs.writeFileSync(briefingFile, briefing, "utf8");

  // Write a launcher script that reads the briefing and passes it as claude's prompt.
  // macOS ARG_MAX is ~1MB; our briefings are ~12-20KB so this is safe.
  // The script uses a bash variable to avoid shell escaping issues.
  const launcherFile = path.join(tmpDir, `${handoffId || "handoff"}-launch.sh`);
  const launcherScript = `#!/bin/bash
cd ${escapeShell(cwd)}
PROMPT=$(cat ${escapeShell(briefingFile)})
exec claude "$PROMPT"
`;
  fs.writeFileSync(launcherFile, launcherScript, { mode: 0o755 });

  const claudeCmd = `bash ${escapeShell(launcherFile)}`;

  // Open a new Terminal.app window and run claude
  const appleScript = `
    tell application "Terminal"
      activate
      do script "${claudeCmd.replace(/"/g, '\\"')}"
    end tell
  `;

  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", appleScript], { timeout: 10000 }, (err) => {
      if (err) {
        console.error("[handoff] Terminal.app failed, trying iTerm2:", err.message);
        const itermScript = `
          tell application "iTerm2"
            activate
            create window with default profile command "${claudeCmd.replace(/"/g, '\\"')}"
          end tell
        `;
        execFile("/usr/bin/osascript", ["-e", itermScript], { timeout: 10000 }, (err2) => {
          if (err2) {
            reject(new Error(`Failed to open terminal: ${err.message}`));
          } else {
            resolve({ ok: true, method: "iterm2", briefing_file: briefingFile });
          }
        });
      } else {
        resolve({ ok: true, method: "terminal.app", briefing_file: briefingFile });
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
    projectConfig = {}
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

  // ── CLAUDE.md (project instructions) ──
  if (cwd) {
    const claudeMdPath = path.join(cwd, "CLAUDE.md");
    const claudeMd = safeReadFile(claudeMdPath);
    if (claudeMd) {
      sections.push(`## Project Instructions (CLAUDE.md)\n${claudeMd}`);
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
