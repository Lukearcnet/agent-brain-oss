/**
 * Codex Session Discovery
 *
 * Reads Codex session data from:
 * - ~/.codex/session_index.jsonl (lightweight index)
 * - ~/.codex/state_5.sqlite (main database with threads table)
 * - ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (per-session events)
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { getDisplaySessionTitle, getProjectNameFromPath } = require("./session-titles");

const CODEX_DIR = path.join(os.homedir(), ".codex");
const SQLITE_DB = path.join(CODEX_DIR, "state_5.sqlite");
const SESSION_INDEX = path.join(CODEX_DIR, "session_index.jsonl");

/**
 * Check if Codex is installed/configured on this machine
 */
function isCodexAvailable() {
  return fs.existsSync(CODEX_DIR) && fs.existsSync(SQLITE_DB);
}

/**
 * Execute a SQLite query and return results as array of objects
 */
function querySqlite(sql) {
  if (!fs.existsSync(SQLITE_DB)) {
    return [];
  }

  try {
    // Use -json mode for structured output
    const result = execSync(
      `sqlite3 -json "${SQLITE_DB}" "${sql.replace(/"/g, '\\"')}"`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );
    return JSON.parse(result || "[]");
  } catch (err) {
    console.error("[codex-discovery] SQLite query failed:", err.message);
    return [];
  }
}

/**
 * Get all Codex sessions (non-archived)
 * Returns array of session objects with fields matching Agent Brain session structure
 */
function getSessions({ includeArchived = false, limit = 100 } = {}) {
  const archivedClause = includeArchived ? "" : "AND archived = 0";

  const rows = querySqlite(`
    SELECT
      id,
      title,
      cwd,
      updated_at,
      created_at,
      archived,
      model_provider,
      tokens_used,
      git_branch,
      first_user_message
    FROM threads
    WHERE 1=1 ${archivedClause}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `);

  // Transform to Agent Brain session format
  // Note: SQLite stores timestamps as Unix seconds, need to multiply by 1000
  return rows.map(row => ({
    session_id: row.id,
    title: getDisplaySessionTitle({
      title: row.title,
      firstUserMessage: row.first_user_message,
      projectName: getProjectNameFromPath(row.cwd),
      provider: "codex",
      createdAt: new Date(row.created_at * 1000).toISOString(),
      updatedAt: new Date(row.updated_at * 1000).toISOString()
    }),
    provider: "codex",
    project_dir: row.cwd,  // Maps to projects.json via cwd
    updated_at: new Date(row.updated_at * 1000).toISOString(),
    created_at: new Date(row.created_at * 1000).toISOString(),
    archived: row.archived === 1,
    first_user_message: row.first_user_message || "",
    metadata: {
      model_provider: row.model_provider,
      tokens_used: row.tokens_used,
      git_branch: row.git_branch
    }
  }));
}

/**
 * Get a single Codex session by ID
 */
function getSession(sessionId) {
  const rows = querySqlite(`
    SELECT
      id,
      title,
      cwd,
      updated_at,
      created_at,
      archived,
      model_provider,
      tokens_used,
      git_branch,
      rollout_path,
      first_user_message
    FROM threads
    WHERE id = '${sessionId.replace(/'/g, "''")}'
    LIMIT 1
  `);

  if (rows.length === 0) return null;

  const row = rows[0];
  // Note: SQLite stores timestamps as Unix seconds, need to multiply by 1000
  return {
    session_id: row.id,
    title: getDisplaySessionTitle({
      title: row.title,
      firstUserMessage: row.first_user_message,
      projectName: getProjectNameFromPath(row.cwd),
      provider: "codex",
      createdAt: new Date(row.created_at * 1000).toISOString(),
      updatedAt: new Date(row.updated_at * 1000).toISOString()
    }),
    provider: "codex",
    project_dir: row.cwd,
    updated_at: new Date(row.updated_at * 1000).toISOString(),
    created_at: new Date(row.created_at * 1000).toISOString(),
    archived: row.archived === 1,
    rollout_path: row.rollout_path,
    first_user_message: row.first_user_message || "",
    metadata: {
      model_provider: row.model_provider,
      tokens_used: row.tokens_used,
      git_branch: row.git_branch
    }
  };
}

/**
 * Get sessions for a specific project directory
 */
function getSessionsByProject(projectDir) {
  const rows = querySqlite(`
    SELECT
      id,
      title,
      cwd,
      updated_at,
      archived,
      first_user_message
    FROM threads
    WHERE cwd = '${projectDir.replace(/'/g, "''")}'
    AND archived = 0
    ORDER BY updated_at DESC
  `);

  // Note: SQLite stores timestamps as Unix seconds, need to multiply by 1000
  return rows.map(row => ({
    session_id: row.id,
    title: getDisplaySessionTitle({
      title: row.title,
      firstUserMessage: row.first_user_message,
      projectName: getProjectNameFromPath(row.cwd),
      provider: "codex",
      updatedAt: new Date(row.updated_at * 1000).toISOString()
    }),
    provider: "codex",
    project_dir: row.cwd,
    updated_at: new Date(row.updated_at * 1000).toISOString(),
    archived: row.archived === 1
  }));
}

/**
 * Read messages from a Codex session's rollout JSONL
 * Returns array of messages in a normalized format
 */
function extractCodexText(contentBlocks = []) {
  let text = "";
  for (const block of contentBlocks) {
    if (!block) continue;
    if (block.type === "input_text" || block.type === "output_text" || block.type === "text") {
      text += block.text || "";
    }
  }
  return text.trim();
}

function isCodexResumeControlPrompt(text = "") {
  return (
    typeof text === "string" &&
    text.includes("A checkpoint response is ready in Agent Brain for this session.") &&
    text.includes("bin/ab-checkpoint consume")
  );
}

function isCodexConsumeAck(text = "") {
  return (
    typeof text === "string" &&
    (
      text.includes("I’m consuming the stored checkpoint response now") ||
      text.includes("I'm consuming the stored checkpoint response now")
    )
  );
}

function parseExecCommandArgs(rawArguments = "") {
  if (!rawArguments || typeof rawArguments !== "string") return null;
  try {
    return JSON.parse(rawArguments);
  } catch (_) {
    return null;
  }
}

function isCheckpointConsumeCall(payload = {}) {
  if (payload.name !== "exec_command" && payload.name !== "Bash") return false;
  const parsed = parseExecCommandArgs(payload.arguments || payload.input || "");
  const cmd = parsed?.cmd || "";
  return typeof cmd === "string" && cmd.includes("bin/ab-checkpoint consume");
}

function extractJsonObject(text = "") {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

function extractConsumedCheckpointResponse(output = "") {
  const parsed = extractJsonObject(output);
  if (!parsed || parsed.ready !== true || parsed.consumed !== true) return null;
  if (typeof parsed.response !== "string" || !parsed.response.trim()) return null;
  return parsed.response.trim();
}

function pushCodexMessage(messages, nextMessage) {
  if (!nextMessage) return;

  const last = messages[messages.length - 1];
  if (!last) {
    messages.push(nextMessage);
    return;
  }

  // Codex often emits the same commentary text twice: once via event_msg and once
  // again as a response_item message. Collapse exact adjacent duplicates here.
  if (
    last.role === nextMessage.role &&
    typeof last.content === "string" &&
    typeof nextMessage.content === "string" &&
    last.content === nextMessage.content
  ) {
    return;
  }

  if (
    last.role === "tool" &&
    nextMessage.role === "tool" &&
    last.tool_call_id &&
    last.tool_call_id === nextMessage.tool_call_id &&
    last.content === nextMessage.content
  ) {
    return;
  }

  if (
    last.role === "assistant" &&
    nextMessage.role === "assistant" &&
    Array.isArray(last.tool_calls) &&
    Array.isArray(nextMessage.tool_calls) &&
    last.tool_calls.length === 1 &&
    nextMessage.tool_calls.length === 1 &&
    last.tool_calls[0]?.id &&
    last.tool_calls[0].id === nextMessage.tool_calls[0]?.id
  ) {
    return;
  }

  messages.push(nextMessage);
}

function getSessionMessages(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.rollout_path) return [];

  // rollout_path is already absolute, no need to join with CODEX_DIR
  const rolloutPath = session.rollout_path;
  if (!fs.existsSync(rolloutPath)) return [];

  try {
    const content = fs.readFileSync(rolloutPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    const messages = [];
    const suppressedCallIds = new Set();

    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const payload = event.payload || {};

        if (event.type === "response_item" && payload.type === "message") {
          const text = extractCodexText(payload.content || []);
          if (!text) continue;
          if (payload.role === "user" && isCodexResumeControlPrompt(text)) continue;
          if (payload.role === "assistant" && isCodexConsumeAck(text)) continue;
          if (payload.role === "user" || payload.role === "assistant") {
            pushCodexMessage(messages, { role: payload.role, content: text });
          }

          continue;
        }

        if (event.type === "response_item" && (payload.type === "function_call" || payload.type === "custom_tool_call")) {
          if (isCheckpointConsumeCall(payload)) {
            if (payload.call_id) suppressedCallIds.add(payload.call_id);
            continue;
          }
          if (payload.call_id && payload.name) {
            pushCodexMessage(messages, {
              role: "assistant",
              tool_calls: [{
                id: payload.call_id,
                function: {
                  name: payload.name,
                  arguments: payload.arguments || payload.input || ""
                }
              }]
            });
          }

          continue;
        }

        if (event.type === "response_item" && (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")) {
          if (payload.call_id && suppressedCallIds.has(payload.call_id)) {
            const consumedResponse = extractConsumedCheckpointResponse(payload.output || "");
            if (consumedResponse) {
              pushCodexMessage(messages, {
                role: "user",
                content: consumedResponse
              });
            }
            continue;
          }
          if (payload.call_id) {
            pushCodexMessage(messages, {
              role: "tool",
              tool_call_id: payload.call_id,
              content: payload.output || ""
            });
          }

          continue;
        }

        if (event.type === "event_msg" && payload.type === "agent_message" && payload.message) {
          if (isCodexConsumeAck(payload.message)) continue;
          pushCodexMessage(messages, {
            role: "assistant",
            content: String(payload.message).trim()
          });
        }

      } catch (parseErr) {
        // Skip malformed lines
      }
    }

    return messages;
  } catch (err) {
    console.error("[codex-discovery] Failed to read rollout:", err.message);
    return [];
  }
}

/**
 * Map a project directory to a project key (same logic as Agent Brain)
 */
function cwdToProjectKey(cwd) {
  return cwd.replace(/\//g, "-");
}

/**
 * Get session state/status
 * Note: Without app-server protocol, we can only infer from file timestamps
 */
function getSessionState(sessionId) {
  const session = getSession(sessionId);
  if (!session) return { status: "unknown" };

  const updatedAt = new Date(session.updated_at);
  const ageMs = Date.now() - updatedAt.getTime();

  // If updated within last 2 minutes, likely active
  if (ageMs < 2 * 60 * 1000) {
    return { status: "active", lastActivity: session.updated_at };
  }

  // If updated within last 6 hours, recent/idle
  if (ageMs < 6 * 60 * 60 * 1000) {
    return { status: "recent", lastActivity: session.updated_at };
  }

  return { status: "inactive", lastActivity: session.updated_at };
}

module.exports = {
  isCodexAvailable,
  getSessions,
  getSession,
  getSessionsByProject,
  getSessionMessages,
  getSessionState,
  cwdToProjectKey,
  CODEX_DIR
};
