require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createSDKTask, loadSDK } = require("./lib/sdk-adapter");
const { ensureRepo, createTaskBranch, commitAndPush } = require("./lib/git-ops");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ── Supabase client ──────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Active tasks ─────────────────────────────────────────────────────────────

const activeTasks = new Map(); // taskId → { abortController, task }

// ── Push notifications (ntfy.sh) ─────────────────────────────────────────────

async function sendPush({ title, message, priority }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  try {
    const res = await fetch(`${server}/${topic}`, {
      method: "POST",
      headers: { "Title": title, "Priority": String(priority || 3), "Tags": "robot" },
      body: message || ""
    });
    if (!res.ok) console.warn("[ntfy] Push failed:", res.status);
  } catch (e) { console.warn("[ntfy] Push error:", e.message); }
}

// ── Auto-approval check ──────────────────────────────────────────────────────

function checkToolPolicy(toolName, toolInput, settings) {
  const aa = settings?.autoApproval;
  if (!aa || !aa.enabled) return "ask";

  const tier = aa.tools[toolName];
  if (!tier || tier === "ask") return "ask";
  if (tier === "block") return "block";

  // "auto" — check blocked patterns for Bash
  if (toolName === "Bash" && aa.blockedPatterns && aa.blockedPatterns.length > 0) {
    const input = typeof toolInput === "object" ? JSON.stringify(toolInput) : String(toolInput || "");
    for (const pattern of aa.blockedPatterns) {
      if (input.includes(pattern)) return "block";
    }
  }

  return "auto";
}

// ── Permission bridge (Supabase Realtime) ────────────────────────────────────

async function waitForPermission(permId, timeoutMs = 90000) {
  return new Promise((resolve) => {
    let settled = false;
    let channel;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (channel) supabase.removeChannel(channel);
        resolve({ behavior: "deny", message: "Permission timed out (90s)" });
      }
    }, timeoutMs);

    // Subscribe to updates on this specific permission request row
    channel = supabase
      .channel(`perm-${permId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "permission_requests",
          filter: `id=eq.${permId}`
        },
        (payload) => {
          const row = payload.new;
          if (row.status === "approved" || row.status === "denied") {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              supabase.removeChannel(channel);
              resolve({
                behavior: row.status === "approved" ? "allow" : "deny",
                message: row.status === "denied" ? "Denied by operator" : undefined
              });
            }
          }
        }
      )
      .subscribe();

    // Also poll every 3s in case Realtime misses the event
    const poller = setInterval(async () => {
      if (settled) { clearInterval(poller); return; }
      const { data } = await supabase
        .from("permission_requests")
        .select("status")
        .eq("id", permId)
        .single();
      if (data && (data.status === "approved" || data.status === "denied")) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          clearInterval(poller);
          supabase.removeChannel(channel);
          resolve({
            behavior: data.status === "approved" ? "allow" : "deny",
            message: data.status === "denied" ? "Denied by operator" : undefined
          });
        }
      }
    }, 3000);
  });
}

// ── Task execution ───────────────────────────────────────────────────────────

async function runTask(taskData) {
  const { task_id, prompt, repo_url, default_branch, project_name, model, settings } = taskData;

  let repoDir = null;
  let branchName = null;

  // Update task status to running
  await supabase.from("orchestrator_tasks").update({
    status: "running",
    started_at: new Date().toISOString()
  }).eq("id", task_id);

  await supabase.from("orchestrator_messages").insert({
    role: "system",
    content: `Starting ${project_name} task on Fly.io...`,
    task_id,
    project_name,
    ts: new Date().toISOString()
  });

  // Clone repo and create branch
  if (repo_url) {
    try {
      repoDir = await ensureRepo(repo_url, project_name);
      branchName = await createTaskBranch(repoDir, task_id, default_branch || "main");
    } catch (e) {
      console.error(`[task] Git setup failed for ${project_name}:`, e.message);
      await supabase.from("orchestrator_tasks").update({
        status: "failed",
        error: `Git setup failed: ${e.message}`,
        completed_at: new Date().toISOString()
      }).eq("id", task_id);
      await supabase.from("orchestrator_messages").insert({
        role: "system",
        content: `Failed: ${project_name}: Git setup error — ${e.message}`,
        task_id,
        ts: new Date().toISOString()
      });
      return;
    }
  }

  const cwd = repoDir || "/tmp";
  let outputBuffer = "";

  // Permission bridge
  async function canUseTool(toolName, toolInput, _options) {
    const policy = checkToolPolicy(toolName, toolInput, settings);

    if (policy === "auto") return { behavior: "allow" };
    if (policy === "block") return { behavior: "deny", message: `Tool "${toolName}" blocked by policy` };

    // "ask" — create permission request in Supabase and wait
    const inputSummary = typeof toolInput === "object"
      ? JSON.stringify(toolInput).slice(0, 200)
      : String(toolInput || "").slice(0, 200);

    const permId = `perm-${task_id}-${Date.now()}`;

    await supabase.from("permission_requests").insert({
      id: permId,
      task_id,
      tool_name: toolName,
      tool_input: toolInput,
      input_summary: inputSummary,
      status: "pending"
    });

    // Update task status
    await supabase.from("orchestrator_tasks").update({
      status: "awaiting_permission"
    }).eq("id", task_id);

    // Push notification
    sendPush({
      title: `${project_name}: Allow ${toolName}?`,
      message: inputSummary.slice(0, 200),
      priority: 4
    });

    console.log(`[task] Permission request: ${toolName} for ${project_name} (${permId})`);

    const result = await waitForPermission(permId);

    // Restore running status
    await supabase.from("orchestrator_tasks").update({
      status: "running"
    }).eq("id", task_id);

    console.log(`[task] Permission ${permId}: ${result.behavior}`);
    return result;
  }

  // Create SDK task
  const sdkTask = createSDKTask({
    prompt,
    cwd,
    model: model || "sonnet",
    maxTurns: 50,
    permissionMode: "default",
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
    canUseTool,
  });

  activeTasks.set(task_id, { abortController: sdkTask.abortController, task: taskData });

  // Stream SDK events to Supabase
  sdkTask.events.on("message", async (msg) => {
    if (msg.type === "assistant" && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text && block.text.trim()) {
          outputBuffer += block.text;
          await supabase.from("orchestrator_messages").insert({
            role: "assistant",
            content: block.text,
            task_id,
            project_name,
            update_type: "text",
            ts: new Date().toISOString()
          });
        } else if (block.type === "tool_use") {
          const summary = block.name + (block.input ? ": " + JSON.stringify(block.input).slice(0, 100) : "");
          await supabase.from("orchestrator_messages").insert({
            role: "assistant",
            content: summary,
            task_id,
            project_name,
            update_type: "tool_use",
            ts: new Date().toISOString()
          });
        }
      }
    }
  });

  sdkTask.events.on("done", async () => {
    activeTasks.delete(task_id);

    // Commit and push if we have a repo
    let gitResult = null;
    if (repoDir && branchName) {
      try {
        gitResult = await commitAndPush(repoDir, branchName, task_id, project_name);
      } catch (e) {
        console.error(`[task] Git push failed:`, e.message);
      }
    }

    await supabase.from("orchestrator_tasks").update({
      status: "completed",
      output: outputBuffer.slice(-8000),
      git_branch: gitResult?.branch || null,
      completed_at: new Date().toISOString()
    }).eq("id", task_id);

    const completedMsg = gitResult?.hasChanges
      ? `${project_name} task completed. Changes pushed to branch \`${gitResult.branch}\`.`
      : `${project_name} task completed.`;

    await supabase.from("orchestrator_messages").insert({
      role: "system",
      content: completedMsg,
      task_id,
      project_name,
      update_type: "task_completed",
      ts: new Date().toISOString()
    });

    console.log(`[task] ${task_id} completed`);
  });

  sdkTask.events.on("cancelled", async () => {
    activeTasks.delete(task_id);
    await supabase.from("orchestrator_tasks").update({
      status: "cancelled",
      output: outputBuffer.slice(-8000),
      completed_at: new Date().toISOString()
    }).eq("id", task_id);
    await supabase.from("orchestrator_messages").insert({
      role: "system",
      content: `${project_name} task cancelled.`,
      task_id,
      ts: new Date().toISOString()
    });
  });

  sdkTask.events.on("error", async (err) => {
    activeTasks.delete(task_id);
    await supabase.from("orchestrator_tasks").update({
      status: "failed",
      error: err.message,
      output: outputBuffer.slice(-8000),
      completed_at: new Date().toISOString()
    }).eq("id", task_id);
    await supabase.from("orchestrator_messages").insert({
      role: "system",
      content: `Failed: ${project_name}: ${err.message}`,
      task_id,
      update_type: "task_error",
      ts: new Date().toISOString()
    });
    console.error(`[task] ${task_id} failed:`, err.message);
  });

  // Start execution (non-blocking)
  sdkTask.run().catch((err) => {
    if (activeTasks.has(task_id)) {
      sdkTask.events.emit("error", err);
    }
  });
}

// ── API routes ───────────────────────────────────────────────────────────────

app.post("/tasks/dispatch", async (req, res) => {
  const { task_id, prompt, repo_url, default_branch, project_name, model, settings } = req.body;

  if (!task_id || !prompt) {
    return res.status(400).json({ error: "task_id and prompt required" });
  }

  console.log(`[dispatch] ${project_name || "unknown"}: ${prompt.slice(0, 80)}...`);

  // Start task in background (don't await)
  runTask(req.body).catch(err => {
    console.error(`[dispatch] Unhandled error for ${task_id}:`, err.message);
  });

  res.json({ ok: true, task_id });
});

app.post("/tasks/:taskId/cancel", (req, res) => {
  const { taskId } = req.params;
  const active = activeTasks.get(taskId);
  if (!active) return res.status(404).json({ error: "Task not running" });

  active.abortController.abort();
  res.json({ ok: true });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    active_tasks: activeTasks.size,
    uptime: process.uptime()
  });
});

app.get("/tasks", (_req, res) => {
  const tasks = [];
  for (const [id, { task }] of activeTasks) {
    tasks.push({ id, project_name: task.project_name, status: "running" });
  }
  res.json(tasks);
});

// ── Startup ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Fly Agent Runner listening on port ${PORT}`);

  // Verify SDK is loadable
  loadSDK()
    .then(() => console.log("[sdk] Claude Agent SDK loaded"))
    .catch(e => console.error("[sdk] SDK not available:", e.message));

  // Verify Supabase connection
  supabase.from("settings").select("id").single()
    .then(({ error }) => {
      if (error) console.warn("[supabase] Connection test failed:", error.message);
      else console.log("[supabase] Connected");
    });
});
