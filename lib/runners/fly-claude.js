/**
 * Fly.io Claude Runner
 * Dispatches tasks to the remote Fly.io agent runner service.
 * The runner clones repos, runs Claude Agent SDK, commits & pushes changes.
 */

const FLY_RUNNER_URL = process.env.FLY_RUNNER_URL || "";

// The runner refuses every task route without this bearer (see
// fly-agent-runner/server.js). Read at call time so a .env change only needs
// the usual Agent Brain restart, not a code change.
function authHeaders(extra = {}) {
  const token = process.env.RUNNER_TOKEN;
  if (!token) throw new Error("RUNNER_TOKEN is not set in agent-brain/.env — the Fly runner will refuse the request");
  return { ...extra, Authorization: `Bearer ${token}` };
}

module.exports = {
  name: "fly-claude",
  label: "Fly.io (Claude)",

  /**
   * Dispatch a task to the Fly.io runner.
   * @param {object} task - The orchestrator task object
   * @param {string} prompt - Composed prompt for the agent
   * @param {object} options - { projectConfig, settings }
   * @returns {{ ok: boolean, task_id: string }}
   */
  async dispatch(task, prompt, options = {}) {
    if (!FLY_RUNNER_URL) throw new Error("FLY_RUNNER_URL is not set — deploy fly-agent-runner and set it in .env");
    const { projectConfig, settings } = options;
    const model = task.model || "sonnet";

    const payload = {
      task_id: task.id,
      prompt,
      repo_url: projectConfig?.repo_url || null,
      default_branch: projectConfig?.default_branch || "main",
      project_name: task.project_name,
      project_dir: task.project_dir || null,
      model,
      source: task.source || "trusted", // Security: Pass source for tool restrictions
      settings: {
        autoApproval: settings?.autoApproval || null
      }
    };

    const res = await fetch(`${FLY_RUNNER_URL}/tasks/dispatch`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Fly.io dispatch failed (${res.status}): ${errText}`);
    }

    return { ok: true, task_id: task.id };
  },

  /**
   * Cancel a running task on Fly.io.
   * @param {string} taskId
   * @returns {{ ok: boolean }}
   */
  async cancel(taskId) {
    const res = await fetch(`${FLY_RUNNER_URL}/tasks/${taskId}/cancel`, {
      method: "POST",
      headers: authHeaders()
    });
    if (!res.ok) {
      console.warn(`[fly-claude] Cancel returned ${res.status} for ${taskId}`);
    }
    return { ok: res.ok };
  },

  /**
   * Check if the Fly.io runner is healthy.
   * @returns {{ status: string, active_tasks: number }}
   */
  async healthCheck() {
    if (!FLY_RUNNER_URL) return { status: "not_configured", active_tasks: 0 };
    try {
      const res = await fetch(`${FLY_RUNNER_URL}/health`);
      if (!res.ok) return { status: "unhealthy", active_tasks: 0 };
      return await res.json();
    } catch (e) {
      return { status: "unreachable", active_tasks: 0, error: e.message };
    }
  }
};
