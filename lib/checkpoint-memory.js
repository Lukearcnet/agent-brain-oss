/**
 * Checkpoint Memory System
 *
 * Automatically summarizes checkpoint activity and consolidates into
 * hierarchical memory layers:
 *   1. Per-checkpoint summaries (immediate)
 *   2. Session daily summaries (daily consolidation)
 *   3. Project work streams (continuous detection)
 *
 * This enables:
 *   - Work stream detection for project-level spawning
 *   - Richer handoff briefings
 *   - Automatic context capture without relying on sessions to save memory
 */

const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const db = require("./db");

const anthropic = new Anthropic();

// ── JSONL Chat Reading ──────────────────────────────────────────────────────

/**
 * Read recent chat turns from a Claude Code session JSONL file.
 * Returns the last N turns as a simplified array.
 */
function readRecentChat(claudeSessionId, maxTurns = 30) {
  if (!claudeSessionId) return [];

  // Find JSONL file for this session
  const projectsDir = path.join(process.env.HOME || "", ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return [];

  // Search all project directories for the JSONL file
  let jsonlPath = null;
  try {
    const projectDirs = fs.readdirSync(projectsDir);
    for (const projDir of projectDirs) {
      const candidate = path.join(projectsDir, projDir, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        jsonlPath = candidate;
        break;
      }
    }
  } catch (_) {}

  if (!jsonlPath) return [];

  try {
    const content = fs.readFileSync(jsonlPath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Parse last N lines
    const turns = [];
    for (const line of lines.slice(-maxTurns * 2)) { // *2 to account for multi-line entries
      try {
        const entry = JSON.parse(line);
        if (entry.type === "human" || entry.type === "assistant") {
          const text = typeof entry.message === "string"
            ? entry.message
            : (entry.message?.content || "");
          // Truncate long messages
          const truncated = text.length > 500 ? text.slice(0, 500) + "..." : text;
          turns.push({ role: entry.type, content: truncated });
        }
      } catch (_) {}
    }

    return turns.slice(-maxTurns);
  } catch (_) {
    return [];
  }
}

// ── Haiku Summarization ─────────────────────────────────────────────────────

/**
 * Generate a concise summary of checkpoint activity using Haiku.
 *
 * IMPORTANT: Summaries must be NEUTRAL and DESCRIPTIVE:
 * - Focus on what was ATTEMPTED/WORKED ON, not claimed outcomes
 * - Use phrases like "modified", "attempted", "worked on" NOT "fixed", "completed", "resolved"
 * - The agent may claim success but the fix might not actually work
 */
async function summarizeCheckpoint(checkpoint, recentChat = []) {
  const chatContext = recentChat.length > 0
    ? `\n\nRecent conversation:\n${recentChat.map(t => `${t.role}: ${t.content}`).slice(-10).join("\n")}`
    : "";

  const prompt = `Generate a NEUTRAL, FACTUAL summary of this checkpoint activity. You must return valid JSON only.

IMPORTANT RULES:
- Be DESCRIPTIVE, not evaluative. Describe WHAT was worked on, not whether it succeeded.
- NEVER use words like "fixed", "resolved", "completed", "accomplished". Use "modified", "attempted", "worked on", "changed".
- The agent may claim success but the change might not actually work - stay neutral.
- Focus on: files modified, approaches tried, decisions made by user.

Checkpoint question: ${checkpoint.question}
${checkpoint.response ? `User response: ${checkpoint.response}` : "Status: Pending"}
${checkpoint.options ? `Options offered: ${checkpoint.options.join(", ")}` : ""}
${chatContext}

Identify the work stream as a short slug (e.g., "map-clustering", "member-directory", "auth-flow", "ui-layout", "bug-investigation").

Return ONLY this JSON (no other text):
{"summary": "Neutral description of work attempted...", "work_stream": "short-slug"}`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    });

    const text = response.content[0]?.text || "";
    // Try to parse JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    // Fallback: use raw text as summary
    return { summary: text.slice(0, 200), work_stream: null };
  } catch (err) {
    console.error("[checkpoint-memory] Haiku summarization failed:", err.message);
    // Fallback: simple extraction
    return {
      summary: (checkpoint.question || "").slice(0, 150),
      work_stream: null
    };
  }
}

// ── Checkpoint Summary Storage ──────────────────────────────────────────────

/**
 * Process a checkpoint and store its summary.
 * Called when a checkpoint is created or responded to.
 */
async function processCheckpoint(checkpoint) {
  if (!checkpoint?.id || !checkpoint?.project_dir) return;

  // Check if already summarized
  const { data: existing } = await db.supabase
    .from("checkpoint_summaries")
    .select("id")
    .eq("checkpoint_id", checkpoint.id)
    .single();

  if (existing) {
    console.log(`[checkpoint-memory] Already summarized: ${checkpoint.id}`);
    return;
  }

  // Read recent chat context
  const recentChat = checkpoint.claude_session_id
    ? readRecentChat(checkpoint.claude_session_id, 20)
    : [];

  // Generate summary
  const result = await summarizeCheckpoint(checkpoint, recentChat);

  // Store summary
  const { error } = await db.supabase
    .from("checkpoint_summaries")
    .insert({
      checkpoint_id: checkpoint.id,
      session_id: checkpoint.session_id || null,
      project_dir: checkpoint.project_dir,
      summary: result.summary,
      work_stream: result.work_stream
    });

  if (error) {
    console.error("[checkpoint-memory] Failed to store summary:", error.message);
  } else {
    console.log(`[checkpoint-memory] Summarized: ${checkpoint.id} → "${result.summary.slice(0, 50)}..."`);
  }

  return result;
}

// ── Daily Consolidation ─────────────────────────────────────────────────────

/**
 * Consolidate checkpoint summaries into session-level daily summaries.
 * Should be run daily (e.g., via cron).
 */
async function runDailyConsolidation() {
  console.log("[checkpoint-memory] Starting daily consolidation...");

  // Get unconsolidated summaries grouped by session and date
  const { data: summaries, error } = await db.supabase
    .from("checkpoint_summaries")
    .select("*")
    .eq("consolidated", false)
    .order("created_at", { ascending: true });

  if (error || !summaries || summaries.length === 0) {
    console.log("[checkpoint-memory] No summaries to consolidate");
    return { consolidated: 0 };
  }

  // Group by session_id + date
  const groups = new Map();
  for (const s of summaries) {
    const date = new Date(s.created_at).toISOString().split("T")[0];
    const key = `${s.session_id || "no-session"}:${date}`;
    if (!groups.has(key)) {
      groups.set(key, {
        session_id: s.session_id,
        project_dir: s.project_dir,
        date,
        summaries: [],
        work_streams: new Set()
      });
    }
    const group = groups.get(key);
    group.summaries.push(s);
    if (s.work_stream) group.work_streams.add(s.work_stream);
  }

  let consolidated = 0;

  for (const [key, group] of groups) {
    if (group.summaries.length === 0) continue;

    // Generate consolidated summary using Haiku
    const bulletPoints = group.summaries.map(s => `- ${s.summary}`).join("\n");
    let dailySummary;

    try {
      const response = await anthropic.messages.create({
        model: "claude-3-haiku-20240307",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `Consolidate these checkpoint summaries into a concise daily summary (3-5 sentences):\n\n${bulletPoints}`
        }]
      });
      dailySummary = response.content[0]?.text || bulletPoints;
    } catch (_) {
      dailySummary = bulletPoints;
    }

    // Store daily summary
    const { error: insertError } = await db.supabase
      .from("session_daily_summaries")
      .upsert({
        session_id: group.session_id || `project-${group.project_dir}`,
        project_dir: group.project_dir,
        summary_date: group.date,
        summary: dailySummary,
        checkpoint_count: group.summaries.length,
        work_streams: Array.from(group.work_streams)
      }, {
        onConflict: "session_id,summary_date"
      });

    if (insertError) {
      console.error(`[checkpoint-memory] Failed to store daily summary for ${key}:`, insertError.message);
      continue;
    }

    // Mark summaries as consolidated
    const ids = group.summaries.map(s => s.id);
    await db.supabase
      .from("checkpoint_summaries")
      .update({ consolidated: true })
      .in("id", ids);

    consolidated += group.summaries.length;
    console.log(`[checkpoint-memory] Consolidated ${group.summaries.length} summaries for ${key}`);
  }

  console.log(`[checkpoint-memory] Daily consolidation complete: ${consolidated} summaries processed`);
  return { consolidated };
}

// ── Work Stream Detection ───────────────────────────────────────────────────

/**
 * Detect and update work streams for a project.
 * Analyzes recent activity to identify distinct feature areas.
 */
async function detectWorkStreams(projectDir) {
  // Get recent daily summaries
  const { data: dailies } = await db.supabase
    .from("session_daily_summaries")
    .select("*")
    .eq("project_dir", projectDir)
    .order("summary_date", { ascending: false })
    .limit(30);

  // Get recent checkpoint summaries (unconsolidated for latest context)
  const { data: recent } = await db.supabase
    .from("checkpoint_summaries")
    .select("*")
    .eq("project_dir", projectDir)
    .order("created_at", { ascending: false })
    .limit(50);

  // Get session titles for context
  const sessions = await db.listSessions();
  const projectSessions = sessions.filter(s => s.cc_project_dir === projectDir);
  const sessionTitles = projectSessions.map(s => s.title).filter(Boolean);

  if (!dailies?.length && !recent?.length && !sessionTitles.length) {
    return [];
  }

  // Build context for work stream detection
  const context = [];

  if (sessionTitles.length > 0) {
    context.push("Session titles:\n" + sessionTitles.slice(0, 20).map(t => `- ${t}`).join("\n"));
  }

  if (dailies?.length > 0) {
    context.push("Recent daily summaries:\n" + dailies.slice(0, 10).map(d =>
      `[${d.summary_date}] ${d.summary}`
    ).join("\n\n"));
  }

  if (recent?.length > 0) {
    const streams = new Set(recent.filter(r => r.work_stream).map(r => r.work_stream));
    if (streams.size > 0) {
      context.push("Detected work streams: " + Array.from(streams).join(", "));
    }
  }

  // Ask Haiku to identify distinct work streams
  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Analyze this project activity and identify 2-5 distinct work streams (features, areas, or themes being worked on).

${context.join("\n\n")}

Return JSON array:
[
  {"name": "short-slug", "description": "Brief description", "recent_focus": true/false},
  ...
]

Order by most recent activity. Include a "general" stream for miscellaneous work.`
      }]
    });

    const text = response.content[0]?.text || "";
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const streams = JSON.parse(jsonMatch[0]);

      // Update project_work_streams table
      for (const stream of streams) {
        const { error } = await db.supabase
          .from("project_work_streams")
          .upsert({
            project_dir: projectDir,
            stream_name: stream.name,
            description: stream.description,
            active: stream.recent_focus !== false,
            last_activity: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }, {
            onConflict: "project_dir,stream_name"
          });

        if (error) {
          console.error(`[checkpoint-memory] Failed to upsert stream ${stream.name}:`, error.message);
        }
      }

      // Deactivate streams not in the latest detection
      const activeNames = streams.map(s => s.name);
      await db.supabase
        .from("project_work_streams")
        .update({ active: false })
        .eq("project_dir", projectDir)
        .not("stream_name", "in", `(${activeNames.map(n => `'${n}'`).join(",")})`);

      return streams;
    }
  } catch (err) {
    console.error("[checkpoint-memory] Work stream detection failed:", err.message);
  }

  return [];
}

/**
 * Get current work streams for a project.
 */
async function getWorkStreams(projectDir) {
  const { data, error } = await db.supabase
    .from("project_work_streams")
    .select("*")
    .eq("project_dir", projectDir)
    .eq("active", true)
    .order("last_activity", { ascending: false });

  if (error) {
    console.error("[checkpoint-memory] Failed to get work streams:", error.message);
    return [];
  }

  return data || [];
}

// ── Weekly Project Memory Update ────────────────────────────────────────────

/**
 * Update project memory with weekly work summary.
 * Appends a "## Recent Work" section based on consolidated activity.
 */
async function updateProjectMemory(projectDir) {
  // Get last week's daily summaries
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data: weeklySummaries } = await db.supabase
    .from("session_daily_summaries")
    .select("*")
    .eq("project_dir", projectDir)
    .gte("summary_date", weekAgo)
    .order("summary_date", { ascending: false });

  if (!weeklySummaries || weeklySummaries.length === 0) {
    return null;
  }

  // Generate weekly summary
  const dailyTexts = weeklySummaries.map(d => `[${d.summary_date}]\n${d.summary}`).join("\n\n");

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 400,
      messages: [{
        role: "user",
        content: `Summarize this week's work into a concise "Recent Work" section for project memory (5-8 bullet points):\n\n${dailyTexts}`
      }]
    });

    const weeklySection = response.content[0]?.text || "";

    // Read current memory
    const currentMemory = await db.getProjectMemory(projectDir) || "";

    // Replace or append ## Recent Work section
    const recentWorkRegex = /## Recent Work[\s\S]*?(?=\n## |\n*$)/;
    const newSection = `## Recent Work\n${weeklySection}\n`;

    let updatedMemory;
    if (recentWorkRegex.test(currentMemory)) {
      updatedMemory = currentMemory.replace(recentWorkRegex, newSection);
    } else {
      updatedMemory = currentMemory.trim() + "\n\n" + newSection;
    }

    // Save updated memory
    await db.saveProjectMemory(projectDir, updatedMemory);
    console.log(`[checkpoint-memory] Updated project memory for ${projectDir}`);

    return weeklySection;
  } catch (err) {
    console.error("[checkpoint-memory] Failed to update project memory:", err.message);
    return null;
  }
}

// ── Recent Activity Section for Handoffs ─────────────────────────────────────

/**
 * Build a "Recent Activity" section for handoff briefings.
 * Shows what's changed since the last session was active.
 *
 * @param {string} projectDir - Project directory key
 * @param {object} opts
 * @param {string} opts.sinceSessionId - For session handoffs: show activity since this session was last active
 * @param {Date} opts.sinceTime - For morning refreshes: show activity since this timestamp
 * @returns {Promise<string>} - Formatted markdown section, or empty string if no recent activity
 */
async function buildRecentActivitySection(projectDir, opts = {}) {
  if (!projectDir) return "";

  // Determine the cutoff time
  let sinceTime;
  if (opts.sinceTime) {
    sinceTime = new Date(opts.sinceTime);
  } else if (opts.sinceSessionId) {
    // Get last activity time for the source session
    const { data: session } = await db.supabase
      .from("sessions")
      .select("updated_at")
      .eq("session_id", opts.sinceSessionId)
      .single();
    sinceTime = session?.updated_at ? new Date(session.updated_at) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  } else {
    // Default: last 24 hours
    sinceTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
  }

  // Get checkpoint summaries since the cutoff
  const { data: summaries, error } = await db.supabase
    .from("checkpoint_summaries")
    .select("summary, work_stream, created_at")
    .eq("project_dir", projectDir)
    .gte("created_at", sinceTime.toISOString())
    .order("created_at", { ascending: false })
    .limit(20);

  if (error || !summaries || summaries.length === 0) {
    return "";
  }

  // If we have very few summaries, just format them directly
  if (summaries.length <= 3) {
    const bullets = summaries.map(s => `- ${s.summary}`).join("\n");
    return `## Recent Activity\n${bullets}`;
  }

  // For more summaries, use Haiku to create a concise digest
  const summaryList = summaries.map(s => s.summary).join("\n- ");

  try {
    const response = await anthropic.messages.create({
      model: "claude-3-haiku-20240307",
      max_tokens: 300,
      messages: [{
        role: "user",
        content: `Summarize this project activity into 3-5 concise bullets (max 120 chars each). Focus on what was WORKED ON, not claimed outcomes. Be neutral and factual.

Recent checkpoint summaries:
- ${summaryList}

Return ONLY bullet points, one per line, starting with "- ".`
      }]
    });

    const digest = response.content[0]?.text || "";
    // Ensure we have bullet format
    const lines = digest.split("\n").filter(l => l.trim().startsWith("-")).slice(0, 5);
    if (lines.length === 0) {
      // Fallback: use first 3 raw summaries
      const bullets = summaries.slice(0, 3).map(s => `- ${s.summary}`).join("\n");
      return `## Recent Activity\n${bullets}`;
    }
    return `## Recent Activity\n${lines.join("\n")}`;
  } catch (err) {
    console.error("[checkpoint-memory] Failed to build recent activity section:", err.message);
    // Fallback: use first 3 raw summaries
    const bullets = summaries.slice(0, 3).map(s => `- ${s.summary}`).join("\n");
    return `## Recent Activity\n${bullets}`;
  }
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Core functions
  processCheckpoint,
  readRecentChat,
  summarizeCheckpoint,

  // Consolidation
  runDailyConsolidation,

  // Work streams
  detectWorkStreams,
  getWorkStreams,

  // Memory updates
  updateProjectMemory,

  // Handoff context
  buildRecentActivitySection
};
