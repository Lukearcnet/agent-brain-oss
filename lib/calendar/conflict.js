/**
 * Conflict Detection — Cross-account calendar conflict finder
 *
 * Detects overlapping events from different accounts to surface
 * scheduling conflicts across the user's 5 Gmail calendars.
 */

/**
 * Detect conflicts between events from different accounts.
 * Two events conflict if they're from different accounts and their
 * time ranges overlap (excluding all-day events).
 *
 * @param {Array} events - [{id, account_id, start_time, end_time, all_day, title, ...}]
 * @returns {Array} [{event1, event2, overlapMinutes}]
 */
function detectConflicts(events) {
  // Filter out all-day events and cancelled events
  const timed = events.filter(e => !e.all_day && e.status !== "cancelled");

  // Sort by start time
  timed.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  const conflicts = [];

  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];

      // If b starts after a ends, no more overlaps with a
      const aEnd = new Date(a.end_time);
      const bStart = new Date(b.start_time);
      if (bStart >= aEnd) break;

      // Only flag conflicts between DIFFERENT accounts
      if (a.account_id === b.account_id) continue;

      // Calculate overlap
      const aStart = new Date(a.start_time);
      const bEnd = new Date(b.end_time);
      const overlapStart = Math.max(aStart.getTime(), bStart.getTime());
      const overlapEnd = Math.min(aEnd.getTime(), bEnd.getTime());
      const overlapMinutes = Math.round((overlapEnd - overlapStart) / 60000);

      if (overlapMinutes > 0) {
        conflicts.push({ event1: a, event2: b, overlapMinutes });
      }
    }
  }

  return conflicts;
}

/**
 * Get conflicts for a date range from the database.
 *
 * @param {object} db - Supabase client
 * @param {string} startDate - ISO date string
 * @param {string} endDate - ISO date string
 * @returns {Array} conflict pairs
 */
async function getConflictsForRange(db, startDate, endDate) {
  const { data, error } = await db
    .from("calendar_events")
    .select("*, email_accounts!inner(label, email, calendar_color)")
    .gte("start_time", startDate)
    .lte("start_time", endDate)
    .neq("status", "cancelled")
    .eq("all_day", false)
    .order("start_time");

  if (error) {
    console.error("[calendar] Failed to load events for conflict check:", error.message);
    return [];
  }

  return detectConflicts(data || []);
}

module.exports = { detectConflicts, getConflictsForRange };
