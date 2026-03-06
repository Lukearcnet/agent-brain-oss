const NTFY_TOPIC = process.env.NTFY_TOPIC || "Agent-brain";
const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";
const AGENT_BRAIN_URL =
  process.env.AGENT_BRAIN_URL || "http://localhost:3030";

// Derive Agent Brain project dir from cwd (same encoding as Claude Code)
const AGENT_BRAIN_PROJECT_DIR =
  process.env.AGENT_BRAIN_PROJECT_DIR || process.cwd().replace(/\//g, "-");

function formatBriefing(picks, totalItems, runType) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeLabel = runType === "morning" ? "Morning" : "Evening";

  let text = "";
  picks.forEach((item, i) => {
    const tag = item.score === "directly useful" ? "directly useful" : "worth watching";
    text += `${i + 1}. [${tag}] ${item.title}\n`;
    text += `   ${item.summary}\n`;
    text += `   → ${item.link}\n\n`;
  });

  text += `---\nFiltered from ${totalItems} items across 6 sources.`;

  const title = `AI Briefing - ${dateStr} (${timeLabel})`;
  const hasDirectlyUseful = picks.some(
    (p) => p.score === "directly useful"
  );

  return { title, text, priority: hasDirectlyUseful ? 4 : 3 };
}

async function sendNotification(picks, totalItems, runType) {
  if (picks.length === 0) {
    console.log("[notify] No notable items — skipping notification.");
    return;
  }

  const { title, text, priority } = formatBriefing(
    picks,
    totalItems,
    runType
  );

  const url = `${NTFY_SERVER}/${NTFY_TOPIC}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Title: title,
        Priority: String(priority),
        Tags: "brain",
      },
      body: text,
    });
    if (!res.ok) {
      console.error(`[notify] ntfy.sh returned ${res.status}`);
    } else {
      console.log(`[notify] Sent: ${title}`);
    }
  } catch (e) {
    console.error("[notify] Send error:", e.message);
  }
}

async function saveBriefing(supabase, picks, totalItems, runType, sourcesSummary) {
  const { title, text } = formatBriefing(picks, totalItems, runType);

  // Save to Supabase briefings table
  try {
    await supabase.from("ai_monitor_briefings").insert({
      run_type: runType,
      raw_item_count: totalItems,
      filtered_items: picks,
      briefing_text: text,
      sources_summary: sourcesSummary,
    });
  } catch (e) {
    console.error("[notify] Failed to save briefing to Supabase:", e.message);
  }

  // Also post to Agent Brain daily log
  try {
    await fetch(`${AGENT_BRAIN_URL}/api/memory/${AGENT_BRAIN_PROJECT_DIR}/daily`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `## AI Briefing (${runType})\n${text}`,
      }),
    });
  } catch (e) {
    console.error("[notify] Failed to post to Agent Brain daily log:", e.message);
  }
}

module.exports = { sendNotification, saveBriefing, formatBriefing };
