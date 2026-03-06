/**
 * Local Runner
 * Runs Claude Agent SDK tasks locally on the Mac.
 * Fallback runner for when Fly.io is down or for quick tasks that
 * don't need repo cloning / remote execution.
 *
 * NOTE: This will use the local Claude Code installation and may conflict
 * with active Claude Code sessions. Use sparingly — prefer fly-claude.
 */

const { createSDKTask, loadSDK } = require("../sdk-adapter");
const db = require("../db");

// Track active local tasks
const localActiveTasks = new Map(); // taskId → { abortController, events }

module.exports = {
  name: "local",
  label: "Local (Mac)",

  /**
   * Dispatch a task to run locally via the Claude Agent SDK.
   * @param {object} task - The orchestrator task object
   * @param {string} prompt - Composed prompt for the agent
   * @param {object} options - { projectConfig, settings }
   * @returns {{ ok: boolean, task_id: string }}
   */
  async dispatch(task, prompt, options = {}) {
    const { settings } = options;
    const model = task.model || "sonnet";

    // Update task status to running
    await db.supabase.from("orchestrator_tasks").update({
      status: "running",
      started_at: new Date().toISOString()
    }).eq("id", task.id);

    await db.supabase.from("orchestrator_messages").insert({
      role: "system",
      content: `Starting ${task.project_name} task locally on Mac...`,
      task_id: task.id,
      project_name: task.project_name,
      ts: new Date().toISOString()
    });

    // Determine cwd — use project's local path
    const cwd = task.cwd || process.cwd();

    // Auto-approval check
    function checkToolPolicy(toolName, toolInput) {
      const aa = settings?.autoApproval;
      if (!aa || !aa.enabled) return "ask";
      const tier = aa.tools?.[toolName];
      if (!tier || tier === "ask") return "ask";
      if (tier === "block") return "block";
      if (toolName === "Bash" && aa.blockedPatterns?.length > 0) {
        const input = typeof toolInput === "object" ? JSON.stringify(toolInput) : String(toolInput || "");
        for (const pattern of aa.blockedPatterns) {
          if (input.includes(pattern)) return "block";
        }
      }
      return "auto";
    }

    // Permission callback — writes to Supabase for phone approval
    async function canUseTool(toolName, toolInput) {
      const policy = checkToolPolicy(toolName, toolInput);
      if (policy === "auto") return { behavior: "allow" };
      if (policy === "block") return { behavior: "deny", message: `Tool "${toolName}" blocked by policy` };

      // For "ask" — create permission request in Supabase (same pattern as Fly.io)
      const inputSummary = typeof toolInput === "object"
        ? JSON.stringify(toolInput).slice(0, 200)
        : String(toolInput || "").slice(0, 200);

      const permId = `perm-${task.id}-${Date.now()}`;

      await db.supabase.from("permission_requests").insert({
        id: permId,
        task_id: task.id,
        tool_name: toolName,
        tool_input: toolInput,
        input_summary: inputSummary,
        status: "pending"
      });

      await db.supabase.from("orchestrator_tasks").update({
        status: "awaiting_permission"
      }).eq("id", task.id);

      console.log(`[local] Permission request: ${toolName} for ${task.project_name} (${permId})`);

      // Wait for approval via Supabase Realtime (poll-based for simplicity)
      const result = await waitForPermission(permId);

      await db.supabase.from("orchestrator_tasks").update({
        status: "running"
      }).eq("id", task.id);

      return result;
    }

    // Create SDK task
    const sdkTask = createSDKTask({
      prompt,
      cwd,
      model,
      maxTurns: 50,
      permissionMode: "default",
      allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
      canUseTool,
    });

    localActiveTasks.set(task.id, {
      abortController: sdkTask.abortController,
      events: sdkTask.events
    });

    let outputBuffer = "";

    // Stream events to Supabase
    sdkTask.events.on("message", async (msg) => {
      if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text?.trim()) {
            outputBuffer += block.text;
            await db.supabase.from("orchestrator_messages").insert({
              role: "assistant",
              content: block.text,
              task_id: task.id,
              project_name: task.project_name,
              update_type: "text",
              ts: new Date().toISOString()
            });
          } else if (block.type === "tool_use") {
            const summary = block.name + (block.input ? ": " + JSON.stringify(block.input).slice(0, 100) : "");
            await db.supabase.from("orchestrator_messages").insert({
              role: "assistant",
              content: summary,
              task_id: task.id,
              project_name: task.project_name,
              update_type: "tool_use",
              ts: new Date().toISOString()
            });
          }
        }
      }
    });

    sdkTask.events.on("done", async () => {
      localActiveTasks.delete(task.id);
      await db.supabase.from("orchestrator_tasks").update({
        status: "completed",
        output: outputBuffer.slice(-8000),
        completed_at: new Date().toISOString()
      }).eq("id", task.id);
      await db.supabase.from("orchestrator_messages").insert({
        role: "system",
        content: `${task.project_name} task completed (local runner).`,
        task_id: task.id,
        project_name: task.project_name,
        update_type: "task_completed",
        ts: new Date().toISOString()
      });
      console.log(`[local] ${task.id} completed`);
    });

    sdkTask.events.on("cancelled", async () => {
      localActiveTasks.delete(task.id);
      await db.supabase.from("orchestrator_tasks").update({
        status: "cancelled",
        output: outputBuffer.slice(-8000),
        completed_at: new Date().toISOString()
      }).eq("id", task.id);
    });

    sdkTask.events.on("error", async (err) => {
      localActiveTasks.delete(task.id);
      await db.supabase.from("orchestrator_tasks").update({
        status: "failed",
        error: err.message,
        output: outputBuffer.slice(-8000),
        completed_at: new Date().toISOString()
      }).eq("id", task.id);
      await db.supabase.from("orchestrator_messages").insert({
        role: "system",
        content: `Failed: ${task.project_name}: ${err.message}`,
        task_id: task.id,
        update_type: "task_error",
        ts: new Date().toISOString()
      });
      console.error(`[local] ${task.id} failed:`, err.message);
    });

    // Start execution (non-blocking)
    sdkTask.run().catch((err) => {
      if (localActiveTasks.has(task.id)) {
        sdkTask.events.emit("error", err);
      }
    });

    return { ok: true, task_id: task.id };
  },

  /**
   * Cancel a running local task.
   */
  async cancel(taskId) {
    const active = localActiveTasks.get(taskId);
    if (!active) return { ok: false };
    active.abortController.abort();
    localActiveTasks.delete(taskId);
    return { ok: true };
  },

  /**
   * Health check — local runner is always available if SDK loads.
   */
  async healthCheck() {
    try {
      await loadSDK();
      return { status: "ok", active_tasks: localActiveTasks.size };
    } catch (e) {
      return { status: "sdk_unavailable", active_tasks: 0, error: e.message };
    }
  }
};

// ── Permission polling (same pattern as Fly.io runner) ─────────────────────

async function waitForPermission(permId, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let settled = false;
    let channel;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (channel) db.supabase.removeChannel(channel);
        resolve({ behavior: "deny", message: "Permission timed out (90s)" });
      }
    }, timeoutMs);

    // Subscribe via Realtime
    channel = db.supabase
      .channel(`local-perm-${permId}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "permission_requests",
        filter: `id=eq.${permId}`
      }, (payload) => {
        const row = payload.new;
        if ((row.status === "approved" || row.status === "denied") && !settled) {
          settled = true;
          clearTimeout(timer);
          db.supabase.removeChannel(channel);
          resolve({
            behavior: row.status === "approved" ? "allow" : "deny",
            message: row.status === "denied" ? "Denied by operator" : undefined
          });
        }
      })
      .subscribe();

    // Poll fallback
    const poller = setInterval(async () => {
      if (settled) { clearInterval(poller); return; }
      const { data } = await db.supabase
        .from("permission_requests")
        .select("status")
        .eq("id", permId)
        .single();
      if (data && (data.status === "approved" || data.status === "denied") && !settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        db.supabase.removeChannel(channel);
        resolve({
          behavior: data.status === "approved" ? "allow" : "deny",
          message: data.status === "denied" ? "Denied by operator" : undefined
        });
      }
    }, 3000);
  });
}
