/**
 * Maintenance Scheduler
 * Runs maintenance checks on schedule via node-cron
 */

const cron = require("node-cron");

class MaintenanceScheduler {
  constructor({ db, sendPush, checkers }) {
    this.db = db;
    this.sendPush = sendPush;
    this.checkers = checkers;
    this.running = false;
    this.dailyTask = null;
    this.nextDailyRun = null;
    this.lastNotifiedStatus = new Map(); // checkType -> { status, findingsHash }
  }

  /**
   * Start the scheduler.
   */
  async start() {
    if (this.running) return;

    // Check if tables exist by trying a simple query
    try {
      await this.db.supabase.from("maintenance_checks").select("id").limit(1);
    } catch (err) {
      console.log("[maintenance] Tables not created yet. Run migration: supabase/migrations/20260305_maintenance.sql");
      return;
    }

    this.running = true;
    console.log("[maintenance] Scheduler starting...");

    // Daily full check at 6 AM CT (America/Chicago) — includes security
    this.dailyTask = cron.schedule("0 6 * * *", () => this.runAllChecks(), {
      timezone: "America/Chicago"
    });

    // Calculate next daily run
    const now = new Date();
    const next = new Date();
    next.setHours(6, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    this.nextDailyRun = next;

    console.log("[maintenance] Scheduled: all checks daily at 6 AM CT");
  }

  /**
   * Stop the scheduler.
   */
  stop() {
    if (this.dailyTask) this.dailyTask.stop();
    this.running = false;
    console.log("[maintenance] Scheduler stopped");
  }

  /**
   * Get next scheduled run time.
   */
  getNextRun() {
    return this.nextDailyRun?.toISOString();
  }

  /**
   * Run all checks.
   */
  async runAllChecks() {
    console.log("[maintenance] Running all checks...");
    const results = {};

    for (const [checkType, checker] of Object.entries(this.checkers)) {
      try {
        const result = await this.runCheck(checkType);
        results[checkType] = result;
      } catch (err) {
        console.error(`[maintenance] ${checkType} failed:`, err.message);
        results[checkType] = { status: "error", error: err.message };
      }
    }

    // Update next run time
    const next = new Date();
    next.setDate(next.getDate() + 1);
    next.setHours(6, 0, 0, 0);
    this.nextDailyRun = next;

    return results;
  }

  /**
   * Run a specific check.
   * @param {string} checkType
   */
  async runCheck(checkType) {
    if (checkType === "all") {
      return this.runAllChecks();
    }

    const checker = this.checkers[checkType];
    if (!checker) {
      throw new Error(`Unknown check type: ${checkType}`);
    }

    // Check if enabled
    const { data: threshold } = await this.db.supabase
      .from("maintenance_thresholds")
      .select("enabled, config")
      .eq("check_type", checkType)
      .single();

    if (threshold && !threshold.enabled) {
      console.log(`[maintenance] ${checkType} is disabled, skipping`);
      return { status: "skipped", reason: "disabled" };
    }

    console.log(`[maintenance] Running ${checkType}...`);
    const startTime = Date.now();

    try {
      const result = await checker.run(threshold?.config || {});

      // Store result
      const id = `maint-${checkType}-${Date.now()}`;
      await this.db.supabase.from("maintenance_checks").insert({
        id,
        check_type: checkType,
        status: result.status,
        findings: result.findings || [],
        summary: result.summary,
        auto_actions: result.autoActions || null
      });

      // Only notify if status changed since last notification (deduplication)
      const findingsHash = JSON.stringify(
        (result.findings || []).map(f => f.category + ":" + f.severity).sort()
      );
      const lastNotified = this.lastNotifiedStatus.get(checkType);
      const statusChanged = !lastNotified ||
        lastNotified.status !== result.status ||
        lastNotified.findingsHash !== findingsHash;

      if (statusChanged) {
        this.lastNotifiedStatus.set(checkType, { status: result.status, findingsHash });

        if (result.status === "critical") {
          this.sendPush({
            title: `🚨 Maintenance Alert: ${checkType}`,
            message: result.summary,
            priority: 5
          });
        } else if (result.status === "warning") {
          this.sendPush({
            title: `⚠️ Maintenance Warning: ${checkType}`,
            message: result.summary,
            priority: 3
          });
        }
      } else {
        console.log(`[maintenance] ${checkType}: same findings as last run, skipping notification`);
      }

      const duration = Date.now() - startTime;
      console.log(`[maintenance] ${checkType} completed in ${duration}ms: ${result.status}`);

      return result;
    } catch (err) {
      // Store error
      const id = `maint-${checkType}-${Date.now()}`;
      await this.db.supabase.from("maintenance_checks").insert({
        id,
        check_type: checkType,
        status: "error",
        findings: [],
        summary: `Check failed: ${err.message}`
      });

      throw err;
    }
  }
}

module.exports = { MaintenanceScheduler };
