const Anthropic = require("@anthropic-ai/sdk");

let client = null;
function getClient() {
  if (!client) {
    // Read API key - dotenvx may inject after module load
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set. Add it to .env");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

const AGENT_BRAIN_URL =
  process.env.AGENT_BRAIN_URL || "http://localhost:3030";

// Derive Agent Brain project dir from cwd (same encoding as Claude Code)
const AGENT_BRAIN_PROJECT_DIR =
  process.env.AGENT_BRAIN_PROJECT_DIR || process.cwd().replace(/\//g, "-");

async function getProjectContext() {
  try {
    const res = await fetch(
      `${AGENT_BRAIN_URL}/api/memory/${AGENT_BRAIN_PROJECT_DIR}`
    );
    if (!res.ok) return "No project context available.";
    const data = await res.json();
    // Truncate to keep token count reasonable
    const content = data.content || "";
    return content.slice(0, 4000);
  } catch {
    return "No project context available.";
  }
}

function formatItemsForPrompt(items) {
  const grouped = {};
  for (const item of items) {
    const src = item.source;
    if (!grouped[src]) grouped[src] = [];
    grouped[src].push(item);
  }

  let text = "";
  for (const [source, list] of Object.entries(grouped)) {
    text += `\n## ${source.toUpperCase()} (${list.length} items)\n\n`;
    for (const item of list) {
      text += `- **${item.title}**\n`;
      if (item.description) {
        text += `  ${item.description.slice(0, 150)}\n`;
      }
      text += `  Link: ${item.link}\n`;
      if (item.metadata?.stars)
        text += `  Stars: ${item.metadata.stars}\n`;
      if (item.metadata?.points)
        text += `  Points: ${item.metadata.points}\n`;
      if (item.metadata?.trendingScore)
        text += `  Trending: ${item.metadata.trendingScore}\n`;
      text += "\n";
    }
  }
  return text;
}

// Build the static system prompt (cached across runs)
function buildSystemPrompt(projectContext) {
  return `You are a personal AI scout. Your job is to scan a large batch of AI developments and pick the 3-5 that actually matter for the projects I'm building.

Be ruthless - I don't want a news digest. I want "here's what changed that affects YOUR work."

Score each as:
- "directly useful" - something I could use or integrate right now
- "worth watching" - a meaningful shift I should know about

Skip anything that's just incremental or hype. If fewer than 3 items genuinely matter, return fewer.

Here's what I'm building:
${projectContext}

In plain terms: I build tools that let AI agents work autonomously - coordinating tasks, remembering context across sessions, and talking to each other. I also build iOS apps. I care about things like new models, agent frameworks, developer tools, and anything that changes how AI agents can be built or deployed.

## Priority Filter (rank findings by these, in order)

1. CROSS-SESSION SAFETY (highest priority) — I run multiple AI agent sessions concurrently that can edit the same codebase. Anything about: multi-agent coordination, conflict resolution, file locking for AI agents, state management across concurrent sessions, preventing agents from stepping on each other's work. This is my biggest operational risk.

2. COST EFFICIENCY — I need to keep monthly API spend under $100. Anything about: smaller/faster models that maintain quality, prompt compression, smarter context window management (send less tokens, get same result), caching strategies, token-efficient architectures. My handoff briefings are 15-20KB each so anything that helps trim context intelligently is valuable.

3. AUTOMATED VALIDATION — I want my AI agents to verify their own work before asking me to review. Anything about: testing frameworks designed for AI-generated code, CI/CD patterns for agent workflows, snapshot testing, automated QA tools, ways to catch breakage without human review. Applies to both web (Node.js/Express) and iOS (Swift/Xcode) projects.

4. INTEROPERABILITY/DESKTOP INTEGRATION — I currently use hacky workarounds to get messages and context into Claude Code sessions on my Mac. Anything about: APIs or protocols for communicating with AI coding assistants (Claude Code, Cursor, etc.), macOS automation for interacting with AI tools (AppleScript, Shortcuts, accessibility APIs), MCP servers/clients, syncing external data into AI sessions, cross-platform agent communication standards, or ways to bridge Agent Brain with desktop AI interfaces. Even OS-level hacks or novel IPC approaches count here.

5. AI PRODUCT LAUNCHES — I want to stay current on new features and capabilities from major AI companies so I can assess what to replicate in Agent Brain. Track announcements from: Anthropic (Claude, Claude Code), OpenAI (ChatGPT, Codex, GPT models), Google (Gemini, AI Studio), Cursor, Perplexity, Windsurf/Codeium, Replit, GitHub Copilot. Focus on: new agent capabilities, coding assistant features, context management improvements, collaboration features, API changes. For each finding, note whether the feature could be replicated or integrated into Agent Brain.

6. CAPABILITY/UTILITY — New models, agent frameworks, developer tools — but ONLY if they connect concretely to priorities 1-5 above. No "interesting research for its own sake." If a finding doesn't have a clear path to improving the priorities above, skip it.

When multiple findings compete for the 3-5 slots, prefer items from priorities 1-5 over general capability improvements. A finding that helps agents not break each other's work, communicate more smoothly, or brings a competitor feature I should replicate beats abstract research every time.

For each pick, write the summary in plain, conversational language. Explain WHY it matters to my specific projects - not just what it is. Think "here's how this connects to what you're building" not "this paper proposes a novel architecture for..."

Respond in this exact JSON format (no markdown fences):
[
  {
    "title": "short, plain-language title",
    "summary": "1-2 sentences in plain language explaining why this matters to my projects specifically. Be concrete about the connection.",
    "score": "directly useful" or "worth watching",
    "priority": "cross-session-safety" or "cost-efficiency" or "automated-validation" or "interoperability" or "product-launches" or "capability",
    "link": "URL",
    "source": "source name"
  }
]`;
}

async function filterItems(items) {
  if (items.length === 0) return { picks: [], totalItems: 0 };

  const projectContext = await getProjectContext();
  const itemsText = formatItemsForPrompt(items);

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    // System prompt with cache_control — cached across morning/evening runs
    // Only re-cached when project context changes (every few days)
    system: [
      {
        type: "text",
        text: buildSystemPrompt(projectContext),
        cache_control: { type: "ephemeral" }
      }
    ],
    messages: [
      {
        role: "user",
        content: `Here are today's raw items (${items.length} total) to filter:\n${itemsText}`,
      },
    ],
  });

  // Log cache performance
  const usage = response.usage || {};
  if (usage.cache_read_input_tokens) {
    console.log(`[filter] Cache hit: ${usage.cache_read_input_tokens} tokens read from cache`);
  }
  if (usage.cache_creation_input_tokens) {
    console.log(`[filter] Cache miss: ${usage.cache_creation_input_tokens} tokens written to cache`);
  }

  const text = response.content[0]?.text || "[]";
  try {
    // Extract JSON from response (handle if wrapped in markdown fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const picks = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    return { picks, totalItems: items.length };
  } catch (e) {
    console.error("[filter] Failed to parse Claude response:", e.message);
    console.error("[filter] Raw response:", text.slice(0, 500));
    return { picks: [], totalItems: items.length };
  }
}

module.exports = { filterItems };
