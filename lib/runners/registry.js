/**
 * Runner Registry
 * Routes tasks to the appropriate runner based on project config and settings.
 *
 * Runners implement:
 *   name: string
 *   label: string
 *   dispatch(task, prompt, options) → { ok, task_id }
 *   cancel(taskId) → { ok }
 *   healthCheck() → { status, active_tasks }
 */

const flyClaudeRunner = require("./fly-claude");
const localRunner = require("./local");

// ── Runner Map ────────────────────────────────────────────────────────────

const runners = new Map();
runners.set("fly-claude", flyClaudeRunner);
runners.set("local", localRunner);

// ── Default and override config ───────────────────────────────────────────

let _config = {
  default: "fly-claude",
  overrides: {}
  // overrides: { "Agent Brain": "local", "quick-fix": "local" }
};

/**
 * Update runner config. Called when settings change.
 * @param {{ default?: string, overrides?: Record<string, string> }} config
 */
function configure(config) {
  if (config) {
    _config = { ..._config, ...config };
    console.log(`[runners] Config updated: default=${_config.default}, overrides=${JSON.stringify(_config.overrides)}`);
  }
}

/**
 * Get the config object (for settings API/UI).
 */
function getConfig() {
  return { ..._config };
}

// ── Runner Selection ──────────────────────────────────────────────────────

/**
 * Get the runner for a given task.
 * Priority: task.runner (explicit) → project override → default
 */
function getRunner(task) {
  // 1. Explicit runner on the task
  if (task.runner && runners.has(task.runner)) {
    return runners.get(task.runner);
  }

  // 2. Project-specific override
  const projectName = task.project_name;
  if (projectName && _config.overrides[projectName] && runners.has(_config.overrides[projectName])) {
    return runners.get(_config.overrides[projectName]);
  }

  // 3. Default
  if (runners.has(_config.default)) {
    return runners.get(_config.default);
  }

  // 4. Fallback to fly-claude
  return flyClaudeRunner;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Dispatch a task to the appropriate runner.
 * @param {object} task - Orchestrator task
 * @param {string} prompt - Composed prompt
 * @param {object} options - { projectConfig, settings }
 */
async function dispatch(task, prompt, options = {}) {
  const runner = getRunner(task);
  console.log(`[runners] Routing ${task.project_name} (${task.id}) → ${runner.name}`);
  return runner.dispatch(task, prompt, options);
}

/**
 * Cancel a task. Tries the expected runner, falls back to all runners.
 */
async function cancel(taskId, runnerName) {
  if (runnerName && runners.has(runnerName)) {
    return runners.get(runnerName).cancel(taskId);
  }
  // Try each runner
  for (const [, runner] of runners) {
    const result = await runner.cancel(taskId).catch(() => ({ ok: false }));
    if (result.ok) return result;
  }
  return { ok: false };
}

/**
 * Health check all runners.
 */
async function healthCheckAll() {
  const results = {};
  for (const [name, runner] of runners) {
    try {
      results[name] = await runner.healthCheck();
    } catch (e) {
      results[name] = { status: "error", error: e.message };
    }
  }
  return results;
}

/**
 * List available runners.
 */
function listRunners() {
  return Array.from(runners.values()).map(r => ({
    name: r.name,
    label: r.label
  }));
}

/**
 * Register a new runner (for future extensibility).
 */
function registerRunner(runner) {
  if (!runner.name || !runner.dispatch || !runner.cancel || !runner.healthCheck) {
    throw new Error("Runner must implement: name, dispatch, cancel, healthCheck");
  }
  runners.set(runner.name, runner);
  console.log(`[runners] Registered runner: ${runner.name} (${runner.label})`);
}

module.exports = {
  configure,
  getConfig,
  getRunner,
  dispatch,
  cancel,
  healthCheckAll,
  listRunners,
  registerRunner
};
