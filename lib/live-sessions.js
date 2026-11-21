"use strict";
/**
 * Live Claude Code sessions on this machine — the authoritative terminal map.
 *
 * Claude Code writes ~/.claude/sessions/<pid>.json for every running CLI
 * process: its CURRENT sessionId (it follows /clear and compaction), cwd and
 * status (busy / idle / ...). Agent Brain's spawn launcher exports
 * AB_SESSION_ID into each terminal's environment. Joining the two gives an
 * exact pid → { claude session id, Agent Brain session id, tty } map with no
 * guessing. Everything that used to infer "which terminal is this" from
 * mtimes or titles should use this instead.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const CACHE_TTL_MS = 10000;

let cache = { at: 0, list: [] };

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// One `ps` call for tty + env of all pids. `ps eww` prints the environment
// after the command for processes we own; AB_SESSION_ID is set by the launcher.
function readProcInfo(pids) {
  const info = new Map();
  if (pids.length === 0) return info;
  try {
    const out = execFileSync("/bin/ps", ["eww", "-o", "pid=,tty=,command=", "-p", pids.join(",")], {
      encoding: "utf8", timeout: 4000, maxBuffer: 16 * 1024 * 1024
    });
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const ab = m[3].match(/(?:^|\s)AB_SESSION_ID=([A-Za-z0-9_-]+)/);
      info.set(Number(m[1]), {
        tty: m[2] && m[2] !== "??" ? "/dev/" + m[2] : null,
        abSessionId: ab ? ab[1] : null
      });
    }
  } catch (_) { /* ps failure → no tty/env info, still return the session files */ }
  return info;
}

function encodeProjectDir(cwd) {
  return String(cwd || "").replace(/[^A-Za-z0-9]/g, "-");
}

function findTranscript(cwd, sessionId) {
  if (!sessionId) return null;
  const direct = path.join(PROJECTS_DIR, encodeProjectDir(cwd), sessionId + ".jsonl");
  if (fs.existsSync(direct)) return direct;
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, dir, sessionId + ".jsonl");
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return null;
}

function listLiveSessions({ fresh = false } = {}) {
  if (!fresh && Date.now() - cache.at < CACHE_TTL_MS) return cache.list;
  const entries = [];
  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter(f => /^\d+\.json$/.test(f)); } catch (_) {}
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
      const pid = Number(j.pid || f.replace(".json", ""));
      if (!pid || !pidAlive(pid)) continue;
      if (j.kind && j.kind !== "interactive") continue;
      entries.push({
        pid,
        claudeSessionId: j.sessionId || null,
        cwd: j.cwd || null,
        projectDir: j.cwd ? encodeProjectDir(j.cwd) : null,
        status: j.status || null,
        version: j.version || null,
        name: j.name || null,
        updatedAt: j.updatedAt || j.statusUpdatedAt || null
      });
    } catch (_) {}
  }
  const proc = readProcInfo(entries.map(e => e.pid));
  for (const e of entries) {
    const p = proc.get(e.pid) || {};
    e.tty = p.tty || null;
    e.abSessionId = p.abSessionId || null;
  }
  cache = { at: Date.now(), list: entries };
  return entries;
}

function findByAbSession(abSessionId) {
  if (!abSessionId) return null;
  return listLiveSessions().find(e => e.abSessionId === abSessionId) || null;
}

function findByClaudeSession(claudeSessionId) {
  if (!claudeSessionId) return null;
  return listLiveSessions().find(e => e.claudeSessionId === claudeSessionId) || null;
}

function findByPid(pid) {
  return listLiveSessions().find(e => e.pid === Number(pid)) || null;
}

function invalidate() { cache.at = 0; }

module.exports = {
  listLiveSessions,
  findByAbSession,
  findByClaudeSession,
  findByPid,
  findTranscript,
  encodeProjectDir,
  invalidate
};
