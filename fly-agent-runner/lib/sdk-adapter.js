/**
 * SDK Adapter — ESM/CJS bridge for @anthropic-ai/claude-agent-sdk
 *
 * Wraps the Agent SDK's query() function in a CommonJS-compatible,
 * EventEmitter-based interface. If the SDK changes its API surface,
 * only this file needs updating.
 *
 * Events emitted:
 *   "message"   — raw SDKMessage from the query() AsyncGenerator
 *   "done"      — generator completed normally
 *   "cancelled" — AbortController was triggered
 *   "error"     — any other error during execution
 */

const { EventEmitter } = require("events");

// ── Lazy SDK loader (ESM → CJS bridge) ──────────────────────────────────

let _sdk = null;

async function loadSDK() {
  if (!_sdk) {
    try {
      _sdk = await import("@anthropic-ai/claude-agent-sdk");
    } catch (err) {
      throw new Error(
        `Failed to load Claude Agent SDK: ${err.message}\n` +
        `Install with: npm install @anthropic-ai/claude-agent-sdk`
      );
    }
  }
  return _sdk;
}

// ── Task factory ────────────────────────────────────────────────────────

/**
 * Creates an SDK-backed task with an EventEmitter interface.
 *
 * @param {Object} opts
 * @param {string} opts.prompt        — The prompt to send to the agent
 * @param {string} opts.cwd           — Working directory for file operations
 * @param {string} [opts.model]       — Model to use (default: "sonnet")
 * @param {string} [opts.permissionMode] — Permission mode (default: "default")
 * @param {number} [opts.maxTurns]    — Max agentic turns (default: 50)
 * @param {number} [opts.maxBudgetUsd] — Cost cap in USD
 * @param {string[]} [opts.allowedTools] — Tools the agent can use
 * @param {string} [opts.systemPrompt] — Custom system prompt
 * @param {Object} [opts.hooks]       — SDK hooks object
 * @param {Function} [opts.canUseTool] — Permission callback: (toolName, input, options) → Promise<{behavior}>
 *
 * @returns {{ abortController: AbortController, events: EventEmitter, run: () => Promise<void> }}
 */
function createSDKTask(opts) {
  const abortController = new AbortController();
  const events = new EventEmitter();

  async function run() {
    const sdk = await loadSDK();
    const { query } = sdk;

    const queryOpts = {
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd || process.cwd(),
        model: opts.model || "sonnet",
        permissionMode: opts.permissionMode || "default",
        maxTurns: opts.maxTurns || 50,
        abortSignal: abortController.signal,
      },
    };

    // Optional fields — only add if provided
    if (opts.maxBudgetUsd != null) {
      queryOpts.options.maxBudgetUsd = opts.maxBudgetUsd;
    }
    if (opts.allowedTools) {
      queryOpts.options.allowedTools = opts.allowedTools;
    }
    if (opts.systemPrompt) {
      queryOpts.options.systemPrompt = opts.systemPrompt;
    }
    if (opts.hooks) {
      queryOpts.options.hooks = opts.hooks;
    }
    if (opts.canUseTool) {
      queryOpts.options.canUseTool = opts.canUseTool;
    }

    try {
      for await (const message of query(queryOpts)) {
        // Check abort between messages
        if (abortController.signal.aborted) {
          events.emit("cancelled");
          return;
        }
        events.emit("message", message);
      }
      events.emit("done");
    } catch (err) {
      if (abortController.signal.aborted || err.name === "AbortError") {
        events.emit("cancelled");
      } else {
        events.emit("error", err);
      }
    }
  }

  return { abortController, events, run };
}

module.exports = { loadSDK, createSDKTask };
