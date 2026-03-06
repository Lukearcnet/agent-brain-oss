require("dotenv").config();

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { createSDKTask, loadSDK } = require("./lib/sdk-adapter");
const { ensureRepo, createTaskBranch, commitAndPush, getDiff } = require("./lib/git-ops");
const { execSync } = require("child_process");
const OpenAI = require("openai");

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

// ── Mechanical validation (pre-LLM checks) ───────────────────────────────────

/**
 * Run mechanical validation on changed files before LLM review.
 * Catches objective issues (syntax errors) that don't require LLM judgment.
 * Returns { passed: boolean, issues: string[] }
 */
function mechanicalValidation(repoDir, diffStat) {
  const issues = [];

  // Extract changed JS files from diff stat
  const jsFiles = (diffStat || "")
    .split("\n")
    .map(line => line.trim().split("|")[0]?.trim())
    .filter(f => f && f.endsWith(".js"));

  if (jsFiles.length === 0) {
    return { passed: true, issues: [], skipped: "No JS files changed" };
  }

  for (const file of jsFiles) {
    const fullPath = `${repoDir}/${file}`;
    try {
      execSync(`node -c "${fullPath}"`, { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      // Extract the error message
      const errorMsg = e.stderr || e.message || "Syntax error";
      issues.push(`${file}: ${errorMsg.split("\n")[0]}`);
    }
  }

  return {
    passed: issues.length === 0,
    issues
  };
}

// ── OpenAI client for cross-family review ────────────────────────────────────

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient && process.env.OPENAI_API_KEY) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

// ── Fact extraction from task output ─────────────────────────────────────────

/**
 * Extract facts JSON from task output.
 * Looks for {"facts": [...]} pattern anywhere in the output.
 */
function extractFacts(output) {
  try {
    // Look for JSON with "facts" array
    const match = output.match(/\{"facts"\s*:\s*\[[\s\S]*?\]\s*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.facts)) {
        return parsed.facts.filter(f => f.category && f.fact);
      }
    }
  } catch (_) {}
  return [];
}

/**
 * Write extracted facts to Supabase.
 */
async function saveFacts(projectDir, facts, taskId) {
  if (!facts.length || !projectDir) return { added: 0, confirmed: 0 };

  const added = [];
  const confirmed = [];

  for (const fact of facts) {
    // Check for existing similar fact
    const { data: existing } = await supabase
      .from("memory_facts")
      .select("id, fact, confidence")
      .eq("project_dir", projectDir)
      .eq("category", fact.category)
      .is("superseded_by", null)
      .ilike("fact", `%${fact.fact.slice(0, 50)}%`);

    if (existing && existing.length > 0) {
      // Bump confidence on existing
      const match = existing[0];
      const newConfidence = Math.min(1.0, match.confidence + 0.1);
      await supabase.from("memory_facts").update({
        confidence: newConfidence,
        last_confirmed_at: new Date().toISOString()
      }).eq("id", match.id);
      confirmed.push(match.id);
    } else {
      // Insert new fact
      const { error } = await supabase.from("memory_facts").insert({
        project_dir: projectDir,
        category: fact.category,
        fact: fact.fact,
        source_task_id: taskId,
        confidence: fact.confidence || 1.0,
        last_confirmed_at: new Date().toISOString()
      });
      if (!error) added.push(fact);
    }
  }

  console.log(`[facts] Task ${taskId}: ${added.length} added, ${confirmed.length} confirmed`);
  return { added: added.length, confirmed: confirmed.length };
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

// ── Self-Review (Phase 8) ────────────────────────────────────────────────────
// After task completes, run a quick review of the diff to catch obvious issues.
// Uses a smaller/faster model for cost efficiency.

async function selfReview({ taskId, projectName, taskDescription, repoDir, defaultBranch, outputBuffer }) {
  if (!repoDir) return { passed: true, reason: "No repo — skipping review" };

  const diffResult = await getDiff(repoDir, defaultBranch || "main");
  if (!diffResult.diff || diffResult.fullLength === 0) {
    return { passed: true, reason: "No changes to review" };
  }

  console.log(`[review] Starting self-review for ${taskId} (${diffResult.fullLength} chars diff)`);

  await supabase.from("orchestrator_messages").insert({
    role: "system",
    content: `Running self-review on ${projectName} changes...`,
    task_id: taskId,
    project_name: projectName,
    update_type: "review_start",
    ts: new Date().toISOString()
  });

  // ── Phase 1: Mechanical validation (syntax checks) ──
  const mechanicalResult = mechanicalValidation(repoDir, diffResult.stat);
  if (!mechanicalResult.passed) {
    console.log(`[review] ${taskId}: Mechanical validation FAILED: ${mechanicalResult.issues.join(", ")}`);

    await supabase.from("orchestrator_messages").insert({
      role: "system",
      content: `Self-review: **FAIL** — Syntax errors detected\n- ${mechanicalResult.issues.join("\n- ")}`,
      task_id: taskId,
      project_name: projectName,
      update_type: "review_result",
      ts: new Date().toISOString()
    });

    return {
      passed: false,
      verdict: "fail",
      issues: mechanicalResult.issues,
      summary: "Mechanical validation failed (syntax errors)"
    };
  }
  console.log(`[review] ${taskId}: Mechanical validation passed`);

  // ── Phase 2: Cross-family LLM review (GPT-4o-mini) ──
  // Uses a different model family to avoid self-attribution bias
  // See: SELF-ATTRIBUTION-BIAS-ANALYSIS.md
  const openai = getOpenAI();
  if (!openai) {
    console.warn(`[review] ${taskId}: No OpenAI key — skipping LLM review`);
    return { passed: true, reason: "No OpenAI key configured, mechanical checks passed" };
  }

  const reviewPrompt = `You are a code reviewer. An AI coding agent just completed a task. Review the diff below and determine if the changes are correct and complete.

## Original Task
${(taskDescription || "").slice(0, 1500)}

## Git Diff (stat)
${diffResult.stat}

## Git Diff
${diffResult.diff}

## Agent's Summary
${(outputBuffer || "").slice(-2000)}

## Your Review
Evaluate:
1. Does the diff address the original task?
2. Are there any obvious bugs or broken imports?
3. Are there any files that were changed but shouldn't have been?
4. Is anything obviously missing?

Respond with EXACTLY this JSON format:
{"verdict": "pass" | "warn" | "fail", "issues": ["issue1", "issue2"], "summary": "one line summary"}

- "pass" = looks good, ship it
- "warn" = minor concerns but acceptable (list them in issues)
- "fail" = something is clearly wrong (list in issues)

Be pragmatic. Only fail for actual bugs or task mismatches, not style preferences.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: reviewPrompt }],
      max_tokens: 500,
      temperature: 0.2
    });

    const reviewOutput = response.choices?.[0]?.message?.content || "";

    // Parse the verdict
    const verdictMatch = reviewOutput.match(/\{"verdict"\s*:[\s\S]*?\}/);
    if (verdictMatch) {
      try {
        const result = JSON.parse(verdictMatch[0]);
        console.log(`[review] ${taskId}: GPT-4o-mini verdict=${result.verdict}, issues=${(result.issues || []).length}`);

        await supabase.from("orchestrator_messages").insert({
          role: "system",
          content: `Self-review (GPT-4o-mini): **${result.verdict.toUpperCase()}** — ${result.summary || ""}${result.issues?.length ? "\n- " + result.issues.join("\n- ") : ""}`,
          task_id: taskId,
          project_name: projectName,
          update_type: "review_result",
          ts: new Date().toISOString()
        });

        return {
          passed: result.verdict !== "fail",
          verdict: result.verdict,
          issues: result.issues || [],
          summary: result.summary || ""
        };
      } catch (_) {}
    }

    // Couldn't parse — treat as pass with warning
    console.warn(`[review] ${taskId}: Could not parse GPT review output, treating as pass`);
    return { passed: true, reason: "Review output unparseable", rawOutput: reviewOutput.slice(0, 500) };

  } catch (e) {
    console.warn(`[review] ${taskId}: GPT review failed — ${e.message}`);
    // Mechanical checks passed, so allow through with warning
    return { passed: true, reason: `LLM review error (mechanical passed): ${e.message}` };
  }
}

// ── Task execution ───────────────────────────────────────────────────────────

// ── Tool restrictions by source (Security hardening) ──────────────────────
// External sources (github webhooks, etc) get restricted tool access to prevent
// prompt injection attacks. See: SECURITY-HARDENING-PLAN.md

const TOOLS_BY_SOURCE = {
  trusted: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"],
  github_webhook: ["Read", "Edit", "Glob", "Grep"], // No Bash, Write, WebSearch, WebFetch
  external: ["Read", "Edit", "Glob", "Grep"],       // Same as github_webhook
};

function getAllowedTools(source) {
  if (source && TOOLS_BY_SOURCE[source]) {
    return TOOLS_BY_SOURCE[source];
  }
  return TOOLS_BY_SOURCE.trusted;
}

async function runTask(taskData) {
  const { task_id, prompt, repo_url, default_branch, project_name, model, settings, source } = taskData;

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

  // Security: Restrict tools based on task source
  const allowedTools = getAllowedTools(source);
  if (source && source !== "trusted") {
    console.log(`[task] Source "${source}" → restricted tools: ${allowedTools.join(", ")}`);
    await supabase.from("orchestrator_messages").insert({
      role: "system",
      content: `Security: External task source "${source}" — tools restricted to: ${allowedTools.join(", ")}`,
      task_id,
      project_name,
      update_type: "security",
      ts: new Date().toISOString()
    });
  }

  // Create SDK task
  const sdkTask = createSDKTask({
    prompt,
    cwd,
    model: model || "sonnet",
    maxTurns: 50,
    permissionMode: "default",
    allowedTools,
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

    // Extract and save facts from output
    const projectDir = taskData.project_dir;
    if (projectDir) {
      try {
        const facts = extractFacts(outputBuffer);
        if (facts.length > 0) {
          await saveFacts(projectDir, facts, task_id);
        }
      } catch (e) {
        console.warn(`[facts] Extraction failed:`, e.message);
      }
    }

    // Self-review: quick automated check of changes before marking complete
    let reviewResult = { passed: true };
    if (gitResult?.hasChanges && repoDir) {
      try {
        reviewResult = await selfReview({
          taskId: task_id,
          projectName: project_name,
          taskDescription: prompt,
          repoDir,
          defaultBranch: default_branch || "main",
          outputBuffer
        });
      } catch (e) {
        console.warn(`[review] Review error for ${task_id}:`, e.message);
      }
    }

    // Determine final status based on review
    const finalStatus = reviewResult.passed ? "completed" : "needs_review";

    await supabase.from("orchestrator_tasks").update({
      status: finalStatus,
      output: outputBuffer.slice(-8000),
      git_branch: branchName || gitResult?.branch || null,
      completed_at: new Date().toISOString()
    }).eq("id", task_id);

    const statusEmoji = finalStatus === "completed" ? "" : " ⚠️";
    const completedMsg = branchName
      ? `${project_name} task ${finalStatus}.${statusEmoji} Changes on branch \`${branchName}\`.`
      : `${project_name} task ${finalStatus}.${statusEmoji}`;

    await supabase.from("orchestrator_messages").insert({
      role: "system",
      content: completedMsg + (reviewResult.summary ? `\nReview: ${reviewResult.summary}` : ""),
      task_id,
      project_name,
      update_type: finalStatus === "completed" ? "task_completed" : "task_needs_review",
      ts: new Date().toISOString()
    });

    // Send push notification if review flagged issues
    if (!reviewResult.passed) {
      sendPush({
        title: `Review: ${project_name}`,
        message: `Task needs review: ${reviewResult.summary || "Issues found"}\n${(reviewResult.issues || []).join(", ")}`,
        priority: 4
      });
    }

    console.log(`[task] ${task_id} ${finalStatus}${reviewResult.issues?.length ? ` (${reviewResult.issues.length} issues)` : ""}`);
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

// ── gcloud + Neo4j setup ─────────────────────────────────────────────────────

const { execFileSync } = require("child_process");
const fs = require("fs");

function setupGcloud() {
  const key = process.env.GCLOUD_SERVICE_KEY;
  if (!key) { console.warn("[gcloud] No GCLOUD_SERVICE_KEY — gcloud commands will fail"); return; }
  try {
    const keyPath = "/root/.config/gcloud/sa-key.json";
    fs.writeFileSync(keyPath, Buffer.from(key, "base64").toString("utf8"));
    execFileSync("gcloud", ["auth", "activate-service-account", "--key-file", keyPath], { stdio: "pipe" });
    if (process.env.GCLOUD_PROJECT) {
      execFileSync("gcloud", ["config", "set", "project", process.env.GCLOUD_PROJECT], { stdio: "pipe" });
    }
    console.log("[gcloud] Service account activated" + (process.env.GCLOUD_PROJECT ? `, project: ${process.env.GCLOUD_PROJECT}` : ""));
  } catch (e) { console.error("[gcloud] Setup failed:", e.message); }
}

// ── Startup ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Fly Agent Runner listening on port ${PORT}`);

  // Set up gcloud authentication
  setupGcloud();

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

  // Log Neo4j availability
  if (process.env.NEO4J_URI) console.log(`[neo4j] Configured: ${process.env.NEO4J_URI}`);
  else console.warn("[neo4j] No NEO4J_URI set — neo4j queries unavailable");
});
