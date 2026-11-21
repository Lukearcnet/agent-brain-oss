/**
 * Token Tracker
 *
 * Aggregates token usage from:
 * - Claude Code sessions (JSONL transcript files in ~/.claude/projects/)
 * - Codex sessions (tokens_used from ~/.codex/state_5.sqlite)
 *
 * Caches results to avoid re-parsing large JSONL files on every request.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// In-memory cache: { filePath: { mtime, size, usage } }
const jsonlCache = new Map();

/**
 * Parse a Claude Code JSONL file and extract per-day token usage.
 * Returns { totalUsage, dailyUsage, model, sessionId }
 */
function parseClaudeJsonl(filePath) {
  const stat = fs.statSync(filePath);
  const cached = jsonlCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) {
    return cached.usage;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);

  const dailyUsage = {}; // date -> { input, output, cache_create, cache_read, count }
  let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0, msgCount = 0;
  let model = null;
  let sessionId = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      const msg = d.message || {};
      const usage = msg.usage;

      if (!sessionId && d.sessionId) sessionId = d.sessionId;
      if (!model && msg.model) model = msg.model;

      if (usage) {
        const input = usage.input_tokens || 0;
        const output = usage.output_tokens || 0;
        const cacheCreate = usage.cache_creation_input_tokens || 0;
        const cacheRead = usage.cache_read_input_tokens || 0;

        totalInput += input;
        totalOutput += output;
        totalCacheCreate += cacheCreate;
        totalCacheRead += cacheRead;
        msgCount++;

        // Try to get date from the message or infer from file
        const timestamp = d.timestamp || d.created_at || null;
        if (timestamp) {
          if (!firstTimestamp) firstTimestamp = timestamp;
          lastTimestamp = timestamp;
        }
      }
    } catch (_) {
      // Skip malformed lines
    }
  }

  // Derive date from file modification time if no timestamps found
  const fileDate = new Date(stat.mtimeMs).toISOString().slice(0, 10);

  const result = {
    totalUsage: {
      input_tokens: totalInput,
      output_tokens: totalOutput,
      cache_creation_tokens: totalCacheCreate,
      cache_read_tokens: totalCacheRead,
      message_count: msgCount
    },
    model,
    sessionId,
    date: fileDate,
    filePath
  };

  jsonlCache.set(filePath, { mtime: stat.mtimeMs, size: stat.size, usage: result });
  return result;
}

/**
 * Get all Claude Code session token usage.
 * Scans ~/.claude/projects/ for JSONL files.
 */
function getClaudeCodeUsage() {
  const sessions = [];

  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return sessions;

  const projectDirs = fs.readdirSync(CLAUDE_PROJECTS_DIR).filter(d => {
    const full = path.join(CLAUDE_PROJECTS_DIR, d);
    return fs.statSync(full).isDirectory();
  });

  for (const projectDir of projectDirs) {
    const projectPath = path.join(CLAUDE_PROJECTS_DIR, projectDir);
    let jsonlFiles;
    try {
      jsonlFiles = fs.readdirSync(projectPath).filter(f => f.endsWith(".jsonl"));
    } catch (_) {
      continue;
    }

    for (const jsonlFile of jsonlFiles) {
      const filePath = path.join(projectPath, jsonlFile);
      try {
        const stat = fs.statSync(filePath);
        // Skip empty or tiny files
        if (stat.size < 100) continue;

        const usage = parseClaudeJsonl(filePath);
        sessions.push({
          provider: "claude",
          project_dir: projectDir,
          session_uuid: jsonlFile.replace(".jsonl", ""),
          ...usage
        });
      } catch (err) {
        // Skip files that can't be parsed
      }
    }
  }

  return sessions;
}

/**
 * Get Codex session token usage from SQLite.
 */
function getCodexUsage() {
  const codexDiscovery = require("./codex-discovery");
  if (!codexDiscovery.isCodexAvailable()) return [];

  const sessions = codexDiscovery.getSessions({ includeArchived: true, limit: 500 });
  return sessions
    .filter(s => s.metadata && s.metadata.tokens_used > 0)
    .map(s => ({
      provider: "codex",
      project_dir: codexDiscovery.cwdToProjectKey(s.project_dir || ""),
      session_id: s.session_id,
      totalUsage: {
        // Codex only gives total tokens_used, not broken down
        total_tokens: s.metadata.tokens_used,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        message_count: 0
      },
      model: s.metadata.model_provider || "unknown",
      date: s.updated_at ? s.updated_at.slice(0, 10) : null,
      title: s.title
    }));
}

/**
 * Aggregate all token usage with time-based filtering.
 * @param {string} period - "day", "week", "month", or "all"
 * @returns {{ claude: object, codex: object, daily: Array }}
 */
function getAggregatedUsage(period = "all") {
  const now = new Date();
  let cutoff = null;

  switch (period) {
    case "day":
      cutoff = new Date(now); cutoff.setHours(0, 0, 0, 0);
      break;
    case "week":
      cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 7);
      break;
    case "month":
      cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - 30);
      break;
    default:
      cutoff = null;
  }

  const cutoffStr = cutoff ? cutoff.toISOString().slice(0, 10) : null;

  // Get Claude Code usage
  const claudeSessions = getClaudeCodeUsage();
  const filteredClaude = cutoffStr
    ? claudeSessions.filter(s => s.date >= cutoffStr)
    : claudeSessions;

  const claudeTotal = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    message_count: 0,
    session_count: filteredClaude.length
  };

  for (const s of filteredClaude) {
    claudeTotal.input_tokens += s.totalUsage.input_tokens;
    claudeTotal.output_tokens += s.totalUsage.output_tokens;
    claudeTotal.cache_creation_tokens += s.totalUsage.cache_creation_tokens;
    claudeTotal.cache_read_tokens += s.totalUsage.cache_read_tokens;
    claudeTotal.message_count += s.totalUsage.message_count;
  }

  // Get Codex usage
  const codexSessions = getCodexUsage();
  const filteredCodex = cutoffStr
    ? codexSessions.filter(s => s.date && s.date >= cutoffStr)
    : codexSessions;

  const codexTotal = {
    total_tokens: 0,
    session_count: filteredCodex.length
  };

  for (const s of filteredCodex) {
    codexTotal.total_tokens += s.totalUsage.total_tokens;
  }

  // Build daily breakdown
  const dailyMap = new Map(); // date -> { claude_tokens, codex_tokens }

  for (const s of filteredClaude) {
    const date = s.date;
    if (!dailyMap.has(date)) dailyMap.set(date, { date, claude_tokens: 0, codex_tokens: 0 });
    const day = dailyMap.get(date);
    // Total tokens processed = input + output + cache_creation + cache_read
    // Cache reads are still real usage (tokens the model processed), just cached for speed/cost
    day.claude_tokens += s.totalUsage.input_tokens + s.totalUsage.output_tokens + s.totalUsage.cache_creation_tokens + s.totalUsage.cache_read_tokens;
  }

  for (const s of filteredCodex) {
    const date = s.date;
    if (!date) continue;
    if (!dailyMap.has(date)) dailyMap.set(date, { date, claude_tokens: 0, codex_tokens: 0 });
    dailyMap.get(date).codex_tokens += s.totalUsage.total_tokens;
  }

  const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  return {
    period,
    claude: claudeTotal,
    codex: codexTotal,
    daily,
    sessions: {
      claude: filteredClaude.map(s => ({
        project_dir: s.project_dir,
        session_uuid: s.session_uuid,
        model: s.model,
        date: s.date,
        ...s.totalUsage
      })),
      codex: filteredCodex.map(s => ({
        project_dir: s.project_dir,
        session_id: s.session_id,
        model: s.model,
        date: s.date,
        total_tokens: s.totalUsage.total_tokens,
        title: s.title
      }))
    }
  };
}

module.exports = {
  getClaudeCodeUsage,
  getCodexUsage,
  getAggregatedUsage
};
