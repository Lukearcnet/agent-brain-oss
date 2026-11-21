/**
 * Automation Flags
 *
 * Tiny, dependency-free on/off switches for background automations that must be
 * readable by BOTH the main server and the separate ai-monitor launchd process.
 * Backed by a local JSON file (no DB migration, works cross-process on the same host).
 *
 * Flags:
 *   - aiMonitor:          the paper/news AI monitor service (services/ai-monitor)
 *   - maintenanceMonitor: the in-server maintenance check scheduler (lib/maintenance)
 *   - researchBriefings:  the daily regional intelligence cron (lib/research)
 *
 * All default to OFF. Toggle from Settings in the dashboard.
 */

const fs = require("fs");
const path = require("path");

const FLAGS_PATH = path.join(__dirname, "..", "automation-flags.json");
const DEFAULTS = { aiMonitor: false, maintenanceMonitor: false, researchBriefings: false };

function getFlags() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FLAGS_PATH, "utf8"));
    return { ...DEFAULTS, ...parsed };
  } catch (_) {
    // Missing/unreadable file → everything off (safe default).
    return { ...DEFAULTS };
  }
}

function setFlags(updates) {
  const next = { ...getFlags(), ...(updates || {}) };
  // Only persist known flags to keep the file clean.
  const clean = {};
  for (const k of Object.keys(DEFAULTS)) clean[k] = !!next[k];
  fs.writeFileSync(FLAGS_PATH, JSON.stringify(clean, null, 2) + "\n", "utf8");
  return clean;
}

module.exports = { getFlags, setFlags, FLAGS_PATH, DEFAULTS };
