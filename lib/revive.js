"use strict";
/**
 * Revive — get terminals that lost their connection running again.
 *
 * When the laptop loses network (or sits behind a TLS-intercepting captive
 * portal), every Claude Code session that was mid-turn dies with
 * "API Error: Unable to connect…" and sits idle at its prompt. Its checkpoint
 * wait is gone too, so answering on the phone does nothing. Reviving does
 * exactly what the user would do by hand: type a short instruction into each
 * dead terminal and press Enter.
 *
 * Safety rules (a revive must never disturb a working session):
 *   - only Claude Code terminals that Claude itself reports as "idle"
 *   - only when there is evidence the turn died: the transcript ends in an
 *     API error, or the session's checkpoint has nobody waiting on it
 *   - state is re-checked immediately before typing
 *   - nothing is typed unless the Anthropic API is reachable from this Mac
 *   - text and Enter are sent separately (Claude Code treats a single chunk
 *     ending in CR as a paste and would not submit it)
 */

const fs = require("fs");
const https = require("https");
const { execFile } = require("child_process");
const liveSessions = require("./live-sessions");

const TAIL_BYTES = 256 * 1024;

// ── Transcript tail ────────────────────────────────────────────────────────
function readTail(file) {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    const len = Math.min(TAIL_BYTES, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return { text: buf.toString("utf8"), mtimeMs: st.mtimeMs, size: st.size };
  } catch (_) {
    return null;
  }
}

// Last conversational entry (user/assistant), skipping bookkeeping lines.
function lastTurn(file) {
  const tail = readTail(file);
  if (!tail) return null;
  const lines = tail.text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l || l[0] !== "{") continue;
    let o;
    try { o = JSON.parse(l); } catch (_) { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.isMeta) continue;
    let textContent = "";
    const c = o.message && o.message.content;
    if (typeof c === "string") textContent = c;
    else if (Array.isArray(c)) textContent = c.map(x => x.text || "").join(" ");
    return {
      type: o.type,
      apiError: !!o.isApiErrorMessage,
      text: textContent.slice(0, 300),
      timestamp: o.timestamp || null,
      mtimeMs: tail.mtimeMs,
      size: tail.size
    };
  }
  return { type: null, apiError: false, text: "", timestamp: null, mtimeMs: tail.mtimeMs, size: tail.size };
}

// ── Network ────────────────────────────────────────────────────────────────
let netCache = { at: 0, value: null };
function checkNetwork({ fresh = false } = {}) {
  if (!fresh && netCache.value && Date.now() - netCache.at < 20000) return Promise.resolve(netCache.value);
  return new Promise((resolve) => {
    const done = (value) => { netCache = { at: Date.now(), value }; resolve(value); };
    const req = https.request({ method: "HEAD", hostname: "api.anthropic.com", path: "/", timeout: 6000 }, (res) => {
      res.resume();
      done({ ok: true, status: res.statusCode });
    });
    req.on("timeout", () => { req.destroy(new Error("timed out")); });
    req.on("error", (e) => done({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

// ── Terminal.app ───────────────────────────────────────────────────────────
function osa(script, args = [], timeout = 15000) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script, ...args], { timeout }, (err, stdout) => {
      if (err) reject(err); else resolve(String(stdout).trim());
    });
  });
}

const LIST_TTYS = `
tell application "Terminal"
  set out to ""
  repeat with w in windows
    try
      repeat with t in tabs of w
        set out to out & (tty of t) & linefeed
      end repeat
    end try
  end repeat
  return out
end tell`;

const TYPE_INTO_TTY = `
on run argv
  set theTty to item 1 of argv
  set msg to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      try
        repeat with t in tabs of w
          if tty of t is theTty then
            do script msg in t
            delay 1
            do script "" in t
            return "ok"
          end if
        end repeat
      end try
    end repeat
  end tell
  return "notfound"
end run`;

async function terminalTtys() {
  try {
    const out = await osa(LIST_TTYS, [], 10000);
    return new Set(out.split("\n").map(s => s.trim()).filter(Boolean));
  } catch (_) {
    return null; // Terminal not scriptable right now
  }
}

// ── Messages ───────────────────────────────────────────────────────────────
function oneLine(s, max = 3000) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

function buildMessage(c) {
  if (c.reason === "answer_undelivered" && c.checkpoint) {
    return oneLine(
      `[Agent Brain revive] Your connection dropped while you were waiting on checkpoint ${c.checkpoint.id}. ` +
      `The user already answered it from their phone. Their answer: "${oneLine(c.checkpoint.response, 2500)}" ` +
      `— act on that answer now, then continue with the normal checkpoint flow.`
    );
  }
  return "[Agent Brain revive] Your connection dropped and your last turn failed. " +
    "Repost your last checkpoint now with agent_brain_checkpoint and wait for the user's answer " +
    "(re-posting the same question re-attaches to it — no duplicate card). Do not resume other work until they answer.";
}

// ── Candidates ─────────────────────────────────────────────────────────────
/**
 * deps: {
 *   latestCheckpoint(abSessionId, claudeSessionId) → Promise<row|null>
 *   hasWaiter(checkpointId) → bool
 *   sessionTitle(abSessionId) → Promise<string|null>
 * }
 */
async function listCandidates(deps, { includeAll = false } = {}) {
  const live = liveSessions.listLiveSessions({ fresh: true });
  const ttys = await terminalTtys();
  const out = [];
  for (const e of live) {
    const file = liveSessions.findTranscript(e.cwd, e.claudeSessionId);
    const turn = file ? lastTurn(file) : null;
    const cp = await deps.latestCheckpoint(e.abSessionId, e.claudeSessionId).catch(() => null);
    const waiter = cp && cp.status === "pending" ? deps.hasWaiter(cp.id) : false;
    let title = null;
    try { title = e.abSessionId ? await deps.sessionTitle(e.abSessionId) : null; } catch (_) {}

    let reason = null;
    let detail = "";
    if (e.status === "idle") {
      const lastActivity = turn ? turn.mtimeMs : 0;
      const respondedAt = cp && cp.responded_at ? new Date(cp.responded_at).getTime() : 0;
      // Answered after the transcript last changed, yet the session is idle:
      // the answer never reached it (a delivered answer writes a tool result).
      if (cp && cp.status === "responded" && respondedAt > lastActivity) {
        reason = "answer_undelivered";
        detail = "You answered while it was disconnected";
      } else if (turn && turn.apiError) {
        reason = "api_error";
        detail = oneLine(turn.text, 120);
      } else if (cp && cp.status === "pending" && !waiter) {
        reason = "checkpoint_orphaned";
        detail = "Its checkpoint has nobody waiting on it";
      }
    }

    const inTerminal = ttys ? !!(e.tty && ttys.has(e.tty)) : null;
    const candidate = {
      pid: e.pid,
      tty: e.tty,
      status: e.status,
      version: e.version,
      project_dir: e.projectDir,
      cwd: e.cwd,
      claude_session_id: e.claudeSessionId,
      ab_session_id: e.abSessionId,
      title: title || e.name || e.projectDir,
      reason,
      detail,
      checkpoint: cp ? { id: cp.id, status: cp.status, response: cp.response || null, responded_at: cp.responded_at || null } : null,
      checkpoint_waiter: waiter,
      last_turn_at: turn ? turn.timestamp : null,
      in_terminal: inTerminal,
      revivable: !!reason && inTerminal !== false,
      _turnSize: turn ? turn.size : null
    };
    if (includeAll || candidate.reason) out.push(candidate);
  }
  return out;
}

async function reviveOne(c, deps) {
  // Re-check right before typing: still idle, transcript unchanged.
  liveSessions.invalidate();
  const now = liveSessions.findByPid(c.pid);
  if (!now || now.status !== "idle") return { pid: c.pid, ok: false, error: "no longer idle — left alone" };
  const file = liveSessions.findTranscript(now.cwd, now.claudeSessionId);
  const turn = file ? lastTurn(file) : null;
  if (turn && c._turnSize != null && turn.size !== c._turnSize) {
    return { pid: c.pid, ok: false, error: "transcript changed — left alone" };
  }
  if (!c.tty) return { pid: c.pid, ok: false, error: "no terminal tty" };

  const message = buildMessage(c);
  let result;
  try {
    result = await osa(TYPE_INTO_TTY, [c.tty, message], 20000);
  } catch (e) {
    return { pid: c.pid, ok: false, error: "Terminal scripting failed: " + e.message };
  }
  if (result !== "ok") return { pid: c.pid, ok: false, error: "terminal tab not found (not a Terminal.app window?)" };

  // Confirm Claude picked it up (status flips to busy within a few seconds).
  let confirmed = false;
  for (let i = 0; i < 8 && !confirmed; i++) {
    await new Promise(r => setTimeout(r, 1000));
    liveSessions.invalidate();
    const s = liveSessions.findByPid(c.pid);
    if (s && s.status && s.status !== "idle") confirmed = true;
  }
  if (deps && deps.onRevived) {
    try { await deps.onRevived(c, { confirmed, message }); } catch (_) {}
  }
  return { pid: c.pid, ok: true, confirmed, reason: c.reason, title: c.title };
}

async function reviveAll(deps, { pids = null, force = false } = {}) {
  const net = await checkNetwork({ fresh: true });
  if (!net.ok && !force) {
    return { ok: false, network: net, error: "Anthropic API not reachable from this Mac yet (" + net.error + "). Nothing was typed — try again once you're back online.", results: [] };
  }
  const candidates = (await listCandidates(deps)).filter(c => c.revivable && (!pids || pids.includes(c.pid)));
  const results = [];
  for (const c of candidates) results.push(await reviveOne(c, deps));
  return { ok: true, network: net, results };
}

module.exports = { listCandidates, reviveAll, reviveOne, checkNetwork, buildMessage, lastTurn };
