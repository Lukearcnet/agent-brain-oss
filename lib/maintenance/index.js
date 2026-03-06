/**
 * Maintenance Module
 * Automated health checks for Agent Brain
 */

const { MaintenanceScheduler } = require("./scheduler");
const docsChecker = require("./docs-checker");
const securityScanner = require("./security");
const dbHealth = require("./db-health");
const codeCleanup = require("./code-cleanup");

let scheduler = null;
let db = null;
let sendPush = null;

/**
 * Initialize the maintenance module.
 * @param {object} deps - { db, sendPush }
 */
function init(deps) {
  db = deps.db;
  sendPush = deps.sendPush || (() => {});

  // Pass db to all checkers
  docsChecker.init({ db });
  securityScanner.init({ db });
  dbHealth.init({ db });
  codeCleanup.init({ db });

  // Start scheduler
  scheduler = new MaintenanceScheduler({
    db,
    sendPush,
    checkers: {
      docs_drift: docsChecker,
      security: securityScanner,
      db_health: dbHealth,
      code_cleanup: codeCleanup
    }
  });

  scheduler.start().catch(err => {
    console.error("[maintenance] Failed to start scheduler:", err.message);
  });

  console.log("[maintenance] Module initialized");
}

/**
 * Stop the maintenance scheduler.
 */
function stop() {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}

/**
 * Run a specific check manually.
 * @param {string} checkType - 'docs_drift', 'security', 'db_health', 'code_cleanup', or 'all'
 * @returns {Promise<object>} Check results
 */
async function runCheck(checkType) {
  if (!scheduler) throw new Error("Maintenance module not initialized");
  return scheduler.runCheck(checkType);
}

/**
 * Get recent check results.
 * @param {string} checkType - optional filter by type
 * @param {number} limit - max results
 * @returns {Promise<array>}
 */
async function getRecentChecks(checkType, limit = 20) {
  if (!db) throw new Error("Maintenance module not initialized");

  let query = db.supabase
    .from("maintenance_checks")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (checkType && checkType !== "all") {
    query = query.eq("check_type", checkType);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Get maintenance thresholds.
 * @returns {Promise<object>}
 */
async function getThresholds() {
  if (!db) throw new Error("Maintenance module not initialized");

  const { data, error } = await db.supabase
    .from("maintenance_thresholds")
    .select("*");

  if (error) throw error;

  const thresholds = {};
  for (const row of data || []) {
    thresholds[row.check_type] = {
      config: row.config,
      enabled: row.enabled,
      updated_at: row.updated_at
    };
  }
  return thresholds;
}

/**
 * Update a threshold.
 * @param {string} checkType
 * @param {object} updates - { config, enabled }
 */
async function updateThreshold(checkType, updates) {
  if (!db) throw new Error("Maintenance module not initialized");

  const updateData = { updated_at: new Date().toISOString() };
  if (updates.config !== undefined) updateData.config = updates.config;
  if (updates.enabled !== undefined) updateData.enabled = updates.enabled;

  const { error } = await db.supabase
    .from("maintenance_thresholds")
    .upsert({
      check_type: checkType,
      ...updateData
    }, { onConflict: "check_type" });

  if (error) throw error;
}

/**
 * Get latest check results for all check types.
 * @returns {Promise<object>}
 */
async function getLatestChecks() {
  if (!db) throw new Error("Maintenance module not initialized");

  const checkTypes = ["db_health", "security", "docs_drift", "code_cleanup"];
  const results = {};

  for (const type of checkTypes) {
    const { data } = await db.supabase
      .from("maintenance_checks")
      .select("*")
      .eq("check_type", type)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (data) {
      results[type] = {
        status: data.status,
        summary: data.summary,
        findings: data.findings || [],
        last_run: data.created_at
      };
    }
  }

  return results;
}

/**
 * Register Express routes.
 * @param {object} app - Express app
 */
function registerRoutes(app) {
  // Get recent checks
  app.get("/api/maintenance/checks", async (req, res) => {
    try {
      const checkType = req.query.type;
      const limit = parseInt(req.query.limit) || 20;
      const checks = await getRecentChecks(checkType, limit);
      res.json(checks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run a check manually
  app.post("/api/maintenance/run/:type", async (req, res) => {
    try {
      const result = await runCheck(req.params.type);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get thresholds
  app.get("/api/maintenance/thresholds", async (_req, res) => {
    try {
      const thresholds = await getThresholds();
      res.json(thresholds);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update threshold
  app.put("/api/maintenance/thresholds/:type", async (req, res) => {
    try {
      const updates = {};
      if (req.body.config !== undefined) updates.config = req.body.config;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      await updateThreshold(req.params.type, updates);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get scheduler status with latest check results
  app.get("/api/maintenance/status", async (_req, res) => {
    try {
      const checks = await getLatestChecks();
      res.json({
        running: !!scheduler?.running,
        next_run: scheduler?.getNextRun(),
        checks
      });
    } catch (err) {
      res.json({
        running: !!scheduler?.running,
        next_run: scheduler?.getNextRun(),
        checks: {}
      });
    }
  });
}

module.exports = {
  init,
  stop,
  runCheck,
  getRecentChecks,
  getLatestChecks,
  getThresholds,
  updateThreshold,
  registerRoutes
};
