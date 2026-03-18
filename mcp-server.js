#!/usr/bin/env node

/**
 * Agent Brain MCP Server
 *
 * Exposes Agent Brain's memory, checkpoint, mailbox, contacts, and calendar
 * APIs as MCP tools for Claude Code sessions. Runs as a stdio transport
 * server — Claude Code spawns it as a child process.
 *
 * All tools call the existing Agent Brain HTTP API at localhost:3030.
 */

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const http = require("http");

const AB_BASE = process.env.AGENT_BRAIN_URL || "http://localhost:3030";

// ── HTTP helper (no external deps) ──────────────────────────────────────────

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, AB_BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { "Content-Type": "application/json" },
      timeout: method === "POST" && path.includes("/checkpoints") && !path.includes("/respond")
        ? 14400000  // 4 hours for blocking checkpoint
        : 30000,
    };

    const req = http.request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timed out")); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function text(str) {
  return { content: [{ type: "text", text: typeof str === "string" ? str : JSON.stringify(str, null, 2) }] };
}

function errorResult(msg) {
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const server = new McpServer({
    name: "agent-brain",
    version: "1.0.0",
  });

  // ── Memory Tools ────────────────────────────────────────────────────────

  server.tool(
    "agent_brain_memory_read",
    "Read project memory from Agent Brain. Returns persistent context from previous sessions.",
    {
      project: z.string().describe("Project key (e.g. -Users-lukeblanton-myproject). Use pwd | sed 's|/|-|g' to derive."),
      sections: z.string().optional().describe("Comma-separated section slugs to read (e.g. 'architecture,next-steps'). Omit for full memory."),
      task: z.string().optional().describe("Task description for AI-based section filtering (e.g. 'fix email bug'). Agent Brain picks relevant sections."),
    },
    async ({ project, sections, task }) => {
      try {
        let path = `/api/memory/${encodeURIComponent(project)}`;
        const params = [];
        if (sections) params.push(`sections=${encodeURIComponent(sections)}`);
        if (task) params.push(`task=${encodeURIComponent(task)}`);
        if (params.length) path += `?${params.join("&")}`;

        const res = await request("GET", path);
        if (res.status !== 200) return errorResult(`Status ${res.status}: ${JSON.stringify(res.data)}`);
        return text(res.data.content || res.data);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "agent_brain_memory_write",
    "Write/update project memory in Agent Brain. Structure content with ## headings for section filtering.",
    {
      project: z.string().describe("Project key"),
      content: z.string().describe("Full memory content (markdown with ## Section headings)"),
    },
    async ({ project, content }) => {
      try {
        const res = await request("PUT", `/api/memory/${encodeURIComponent(project)}`, { content });
        if (res.status !== 200) return errorResult(`Status ${res.status}: ${JSON.stringify(res.data)}`);
        return text("Memory updated successfully.");
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "agent_brain_memory_sections",
    "List available memory sections for a project. Use this to discover what sections exist before reading specific ones.",
    {
      project: z.string().describe("Project key"),
    },
    async ({ project }) => {
      try {
        const res = await request("GET", `/api/memory/${encodeURIComponent(project)}?list=true`);
        if (res.status !== 200) return errorResult(`Status ${res.status}`);
        return text(res.data);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "agent_brain_daily_log",
    "Append a daily log entry for a project. Used at session end to record what was done.",
    {
      project: z.string().describe("Project key"),
      content: z.string().describe("Log entry (markdown). Include key accomplishments, decisions, and next steps."),
    },
    async ({ project, content }) => {
      try {
        const res = await request("POST", `/api/memory/${encodeURIComponent(project)}/daily`, { content });
        if (res.status !== 200) return errorResult(`Status ${res.status}`);
        return text("Daily log entry appended.");
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  // ── Checkpoint Tool ─────────────────────────────────────────────────────

  server.tool(
    "agent_brain_checkpoint",
    "Post a checkpoint question to the user (who may respond from their phone). Blocks until the user responds or times out. Use for plan approval, design decisions, clarifying questions, and task completion notifications.",
    {
      project: z.string().describe("Project key"),
      question: z.string().describe("The question or status to present to the user"),
      options: z.array(z.string()).optional().describe("Response options (e.g. ['Yes, proceed', 'Modify approach', 'Cancel'])"),
      session_id: z.string().optional().describe("Agent Brain session ID to attach this checkpoint to"),
      replaces: z.string().optional().describe("ID of a previous checkpoint this one replaces (auto-dismisses the old one to prevent dashboard clutter)"),
    },
    async ({ project, question, options, session_id, replaces }) => {
      try {
        const body = { project_dir: project, question };
        if (options) body.options = options;
        if (session_id) body.session_id = session_id;
        if (replaces) body.replaces = replaces;

        const res = await request("POST", "/api/checkpoints", body);
        if (res.status !== 200 && res.status !== 201) return errorResult(`Status ${res.status}: ${JSON.stringify(res.data)}`);
        return text(res.data);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  // ── Mailbox Tools ───────────────────────────────────────────────────────

  server.tool(
    "agent_brain_mailbox_check",
    "Check for unread messages in the Agent Brain mailbox (project-specific and broadcast).",
    {
      project: z.string().describe("Project key"),
    },
    async ({ project }) => {
      try {
        const [broadcast, project_msgs] = await Promise.all([
          request("GET", "/api/mailbox/broadcast?unread=true"),
          request("GET", `/api/mailbox/${encodeURIComponent(project)}?unread=true`),
        ]);
        const messages = [
          ...(Array.isArray(broadcast.data) ? broadcast.data : []),
          ...(Array.isArray(project_msgs.data) ? project_msgs.data : []),
        ];
        if (messages.length === 0) return text("No unread messages.");
        return text(messages);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "agent_brain_mailbox_send",
    "Send a message to another session or broadcast to all sessions.",
    {
      from_session: z.string().describe("Sender project key"),
      to_session: z.string().describe("Recipient project key, or 'broadcast' for all sessions"),
      subject: z.string().describe("Message subject"),
      body: z.string().describe("Message body"),
    },
    async ({ from_session, to_session, subject, body }) => {
      try {
        const res = await request("POST", "/api/mailbox", { from_session, to_session, subject, body });
        if (res.status !== 200 && res.status !== 201) return errorResult(`Status ${res.status}`);
        return text("Message sent.");
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  server.tool(
    "agent_brain_mailbox_mark_read",
    "Mark a mailbox message as read.",
    {
      message_id: z.string().describe("The message ID to mark as read"),
    },
    async ({ message_id }) => {
      try {
        const res = await request("POST", `/api/mailbox/${encodeURIComponent(message_id)}/read`);
        if (res.status !== 200) return errorResult(`Status ${res.status}`);
        return text("Message marked as read.");
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  // ── Contacts Tool ───────────────────────────────────────────────────────

  server.tool(
    "agent_brain_contacts_search",
    "Search the master contacts list (email + Google People API contacts). Returns names and email addresses.",
    {
      query: z.string().optional().describe("Search query (name or email). Omit to list top contacts by interaction frequency."),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, limit }) => {
      try {
        const params = [];
        if (query) params.push(`q=${encodeURIComponent(query)}`);
        params.push(`limit=${limit || 20}`);
        const res = await request("GET", `/api/email/contacts?${params.join("&")}`);
        if (res.status !== 200) return errorResult(`Status ${res.status}`);
        return text(res.data);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  // ── Calendar Tool ───────────────────────────────────────────────────────

  server.tool(
    "agent_brain_calendar_agenda",
    "Get upcoming calendar events from Google Calendar.",
    {
      days: z.number().optional().describe("Number of days to look ahead (default 7)"),
    },
    async ({ days }) => {
      try {
        const res = await request("GET", `/api/calendar/events?days=${days || 7}`);
        if (res.status !== 200) return errorResult(`Status ${res.status}`);
        return text(res.data);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  // ── Email Triage Tool ───────────────────────────────────────────────────

  server.tool(
    "agent_brain_email_triage",
    "Get email triage summary — emails needing attention (RESPOND_NOW and RESPOND_TODAY).",
    {
      account: z.string().optional().describe("Filter by email account ID. Omit for all accounts."),
      since: z.string().optional().describe("ISO date string to filter emails since (default: last 24 hours)"),
    },
    async ({ account, since }) => {
      try {
        const params = ["classification=RESPOND_NOW,RESPOND_TODAY"];
        if (account) params.push(`account=${encodeURIComponent(account)}`);
        if (since) params.push(`since=${encodeURIComponent(since)}`);
        const res = await request("GET", `/api/email/inbox?${params.join("&")}`);
        if (res.status !== 200) return errorResult(`Status ${res.status}`);
        return text(res.data);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  // ── AI Assistant Tool ───────────────────────────────────────────────────

  server.tool(
    "agent_brain_ai_assistant",
    "Use Agent Brain's AI assistant to draft emails or calendar events using your contacts and context.",
    {
      prompt: z.string().describe("Natural language request (e.g. 'draft an email to Miles Deamer about the project update')"),
    },
    async ({ prompt }) => {
      try {
        const res = await request("POST", "/api/ai-assistant", { prompt });
        if (res.status !== 200) return errorResult(`Status ${res.status}`);
        return text(res.data);
      } catch (e) {
        return errorResult(e.message);
      }
    }
  );

  // ── Health Check ────────────────────────────────────────────────────────

  server.tool(
    "agent_brain_health",
    "Check if the Agent Brain server is running and healthy.",
    {},
    async () => {
      try {
        const res = await request("GET", "/api/health");
        if (res.status === 200) return text("Agent Brain is healthy and running on port 3030.");
        return errorResult(`Agent Brain returned status ${res.status}`);
      } catch (e) {
        return errorResult(`Agent Brain is not reachable: ${e.message}`);
      }
    }
  );

  // ── Start Server ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err.message}\n`);
  process.exit(1);
});
