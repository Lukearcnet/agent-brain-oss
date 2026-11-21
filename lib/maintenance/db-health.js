/**
 * Database Health Checker
 * Monitors database size, orphaned data, and performance
 */

let db = null;

function init(deps) {
  db = deps.db;
}

/**
 * Run the database health check.
 * @param {object} config - Threshold configuration
 * @returns {Promise<object>} Check result
 */
async function run(config = {}) {
  const maxTotalMb = config.max_total_mb || 500;
  const maxHotRows = config.max_hot_rows || 100000;
  const archiveDays = config.archive_days || 30;
  const logRetentionDays = config.log_retention_days || 14;

  const findings = [];
  const autoActions = [];
  let overallStatus = "ok";

  try {
    // 1. Check table sizes
    const tableSizes = await getTableSizes();
    const totalMb = tableSizes.reduce((sum, t) => sum + t.size_mb, 0);

    if (totalMb > maxTotalMb) {
      findings.push({
        severity: "warning",
        category: "size",
        message: `Total database size (${totalMb.toFixed(1)}MB) exceeds threshold (${maxTotalMb}MB)`,
        details: tableSizes.filter(t => t.size_mb > 1).sort((a, b) => b.size_mb - a.size_mb)
      });
      overallStatus = "warning";
    } else {
      findings.push({
        severity: "ok",
        category: "size",
        message: `Database size: ${totalMb.toFixed(1)}MB (limit: ${maxTotalMb}MB)`,
        details: tableSizes.filter(t => t.size_mb > 0.1)
      });
    }

    // 2. Check row counts in hot tables
    const hotTables = ["sessions", "messages", "event_log", "orchestrator_tasks"];
    for (const table of hotTables) {
      const tableInfo = tableSizes.find(t => t.table_name === table);
      if (tableInfo && tableInfo.row_count > maxHotRows) {
        findings.push({
          severity: "warning",
          category: "rows",
          message: `Table "${table}" has ${tableInfo.row_count.toLocaleString()} rows (limit: ${maxHotRows.toLocaleString()})`,
          table: table,
          rows: tableInfo.row_count
        });
        overallStatus = "warning";
      }
    }

    // 3. Check for old sessions that can be archived
    const oldSessions = await getOldSessions(archiveDays);
    if (oldSessions.length > 0) {
      findings.push({
        severity: "info",
        category: "archive",
        message: `${oldSessions.length} sessions older than ${archiveDays} days can be archived`,
        sessions: oldSessions.map(s => ({ id: s.session_id, title: s.title, age_days: s.age_days }))
      });
    }

    // 4. Check for old event logs (auto-cleanup)
    const oldLogCount = await cleanOldLogs(logRetentionDays);
    if (oldLogCount > 0) {
      autoActions.push({
        action: "cleaned_logs",
        count: oldLogCount,
        message: `Deleted ${oldLogCount} event log entries older than ${logRetentionDays} days`
      });
    }

    // 5. Check for orphaned data
    const orphans = await findOrphans();
    if (orphans.total > 0) {
      findings.push({
        severity: "warning",
        category: "orphans",
        message: `Found ${orphans.total} orphaned records`,
        details: orphans.details
      });
      overallStatus = overallStatus === "critical" ? "critical" : "warning";
    }

    // 6. Check for stale locks
    const staleLocks = await cleanStaleLocks();
    if (staleLocks > 0) {
      autoActions.push({
        action: "cleaned_locks",
        count: staleLocks,
        message: `Released ${staleLocks} stale file locks`
      });
    }

  } catch (err) {
    findings.push({
      severity: "critical",
      category: "error",
      message: `Database check failed: ${err.message}`
    });
    overallStatus = "critical";
  }

  // Generate summary
  const warningCount = findings.filter(f => f.severity === "warning").length;
  const criticalCount = findings.filter(f => f.severity === "critical").length;
  let summary = "";

  if (criticalCount > 0) {
    summary = `${criticalCount} critical issue(s) detected`;
    overallStatus = "critical";
  } else if (warningCount > 0) {
    summary = `${warningCount} warning(s) detected`;
  } else {
    summary = "Database healthy";
  }

  if (autoActions.length > 0) {
    summary += ` | Auto-actions: ${autoActions.map(a => a.action).join(", ")}`;
  }

  return {
    status: overallStatus,
    summary,
    findings,
    autoActions
  };
}

/**
 * Get table sizes and row counts.
 */
async function getTableSizes() {
  // Use a simpler approach - query each table's count
  const tables = [
    "sessions", "messages", "event_log", "mailbox", "session_folders",
    "orchestrator_tasks", "orchestrator_messages", "permission_requests",
    "session_checkpoints", "maintenance_checks", "email_accounts", "email_messages",
    "calendar_accounts", "calendar_events", "ai_monitor_briefings", "file_locks"
  ];

  const results = [];
  for (const table of tables) {
    try {
      const { count, error } = await db.supabase
        .from(table)
        .select("*", { count: "exact", head: true });

      if (!error) {
        results.push({
          table_name: table,
          row_count: count || 0,
          size_mb: (count || 0) * 0.001 // Rough estimate: 1KB per row average
        });
      }
    } catch (_) {
      // Table might not exist
    }
  }

  return results;
}

/**
 * Get sessions older than N days.
 */
async function getOldSessions(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data, error } = await db.supabase
    .from("sessions")
    .select("session_id, title, updated_at")
    .lt("updated_at", cutoff.toISOString())
    .order("updated_at", { ascending: true })
    .limit(50);

  if (error) return [];

  return (data || []).map(s => ({
    ...s,
    age_days: Math.floor((Date.now() - new Date(s.updated_at).getTime()) / (1000 * 60 * 60 * 24))
  }));
}

/**
 * Clean old event logs.
 */
async function cleanOldLogs(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  try {
    const { data, error } = await db.supabase
      .from("event_log")
      .delete()
      .lt("ts", cutoff.toISOString())
      .select("id");

    if (error) return 0;
    return data?.length || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Find orphaned records.
 */
async function findOrphans() {
  const details = [];
  let total = 0;

  // Check for messages without sessions
  try {
    const { count } = await db.supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .is("session_id", null);

    if (count > 0) {
      details.push({ type: "messages_without_session", count });
      total += count;
    }
  } catch (_) {}

  // Check for permission requests without tasks
  try {
    const { count } = await db.supabase
      .from("permission_requests")
      .select("*", { count: "exact", head: true })
      .not("task_id", "is", null)
      .eq("status", "pending");

    // Old pending requests (> 1 day old)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 1);

    const { count: oldCount } = await db.supabase
      .from("permission_requests")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("created_at", cutoff.toISOString());

    if (oldCount > 0) {
      details.push({ type: "stale_permission_requests", count: oldCount });
      total += oldCount;
    }
  } catch (_) {}

  return { total, details };
}

/**
 * Clean stale file locks.
 */
async function cleanStaleLocks() {
  try {
    const { data, error } = await db.supabase
      .from("file_locks")
      .delete()
      .lt("expires_at", new Date().toISOString())
      .eq("status", "active")
      .select("id");

    if (error) return 0;
    return data?.length || 0;
  } catch (_) {
    return 0;
  }
}

module.exports = { init, run };
