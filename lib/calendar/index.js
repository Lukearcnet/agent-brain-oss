/**
 * Calendar Module — Entry point
 *
 * Initializes the calendar sync system and exports route handlers
 * for integration with the Agent Brain Express server.
 */

const gcalClient = require("./gcal-client");
const { CalendarScheduler } = require("./scheduler");
const { getConflictsForRange } = require("./conflict");

let scheduler = null;

/**
 * Initialize the calendar module.
 */
function init(db, sendPush, getSettings) {
  const settings = getSettings();
  if (!settings.enabled) {
    console.log("[calendar] Disabled in settings");
    return;
  }

  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    console.log("[calendar] GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set — skipping");
    return;
  }

  scheduler = new CalendarScheduler(db, sendPush, getSettings);
  scheduler.start().catch(err => {
    console.error("[calendar] Failed to start scheduler:", err.message);
  });

  console.log("[calendar] Module initialized");
}

/**
 * Stop the scheduler.
 */
function shutdown() {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}

/**
 * Register all calendar routes on the Express app.
 */
function registerRoutes(app, db, sendPush, getSettings) {

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * Create a new event on a specific account's calendar.
   */
  app.post("/api/calendar/events", async (req, res) => {
    const { account_id, title, description, location, start, end, allDay, attendees, addMeet } = req.body;
    if (!account_id || !title || !start) {
      return res.status(400).json({ error: "account_id, title, and start are required" });
    }

    try {
      const { data: account } = await db
        .from("email_accounts")
        .select("*")
        .eq("id", account_id)
        .single();

      if (!account) return res.status(404).json({ error: "Account not found" });

      const onTokenRefresh = async (newTokens) => {
        await db.from("email_accounts").update({
          tokens_encrypted: gcalClient.encrypt(JSON.stringify(newTokens)),
          updated_at: new Date().toISOString()
        }).eq("id", account.id);
      };

      const { cal } = gcalClient.createCalendarClient(account, onTokenRefresh);
      const event = await gcalClient.createEvent(cal, "primary", {
        title, description, location, start, end, allDay, attendees, addMeet
      });

      // Store in our DB
      const compositeId = `${account.id}:${event.google_event_id}`;
      await db.from("calendar_events").upsert({
        id: compositeId,
        account_id: account.id,
        calendar_id: "primary",
        calendar_name: account.label,
        title: event.title,
        description: event.description,
        location: event.location,
        start_time: event.start_time,
        end_time: event.end_time,
        all_day: event.all_day,
        status: event.status,
        organizer: account.email,
        attendees: event.attendees,
        hangout_link: event.hangout_link,
        synced_at: new Date().toISOString()
      }, { onConflict: "id" });

      res.json({ ok: true, event: { ...event, id: compositeId } });
    } catch (err) {
      console.error("[calendar] Create event error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * List calendar events in a date range.
   * Query params: start, end, account
   */
  app.get("/api/calendar/events", async (req, res) => {
    const {
      start = new Date().toISOString().split("T")[0],
      end,
      account,
      limit = "200"
    } = req.query;

    const startDate = start + "T00:00:00.000Z";
    const endDate = end
      ? end + "T23:59:59.999Z"
      : new Date(new Date(start).getTime() + 14 * 86400000).toISOString();

    let query = db
      .from("calendar_events")
      .select("*, email_accounts!inner(label, email, calendar_color)")
      .gte("start_time", startDate)
      .lte("start_time", endDate)
      .neq("status", "cancelled")
      .order("start_time")
      .limit(parseInt(limit));

    if (account) query = query.eq("account_id", account);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  /**
   * Today's events across all accounts.
   */
  app.get("/api/calendar/events/today", async (req, res) => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

    const { data, error } = await db
      .from("calendar_events")
      .select("*, email_accounts!inner(label, email, calendar_color)")
      .gte("start_time", todayStart)
      .lt("start_time", todayEnd)
      .neq("status", "cancelled")
      .order("start_time");

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  /**
   * This week's events across all accounts.
   */
  app.get("/api/calendar/events/week", async (req, res) => {
    const now = new Date();
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const weekEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();

    const { data, error } = await db
      .from("calendar_events")
      .select("*, email_accounts!inner(label, email, calendar_color)")
      .gte("start_time", weekStart)
      .lt("start_time", weekEnd)
      .neq("status", "cancelled")
      .order("start_time");

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // ── Event Update / Delete ──────────────────────────────────────────────────

  /**
   * Update an existing event (title, time, description, attendees, etc).
   * ID format: "accountId:googleEventId"
   */
  app.patch("/api/calendar/events/:id", async (req, res) => {
    const eventId = req.params.id;
    const colonIdx = eventId.indexOf(':');
    if (colonIdx === -1) return res.status(400).json({ error: "Invalid event ID" });

    const accountId = eventId.substring(0, colonIdx);
    const googleEventId = eventId.substring(colonIdx + 1);

    try {
      const { data: dbEvent } = await db
        .from("calendar_events")
        .select("calendar_id")
        .eq("id", eventId)
        .single();

      if (!dbEvent) return res.status(404).json({ error: "Event not found" });

      const { data: account } = await db
        .from("email_accounts")
        .select("*")
        .eq("id", accountId)
        .single();

      if (!account) return res.status(404).json({ error: "Account not found" });

      const onTokenRefresh = async (newTokens) => {
        await db.from("email_accounts").update({
          tokens_encrypted: gcalClient.encrypt(JSON.stringify(newTokens)),
          updated_at: new Date().toISOString()
        }).eq("id", account.id);
      };

      const { cal } = gcalClient.createCalendarClient(account, onTokenRefresh);
      const updated = await gcalClient.updateEvent(cal, dbEvent.calendar_id, googleEventId, req.body);

      // Update in our DB
      await db.from("calendar_events").update({
        title: updated.title,
        description: updated.description,
        location: updated.location,
        start_time: updated.start_time,
        end_time: updated.end_time,
        all_day: updated.all_day,
        attendees: updated.attendees,
        hangout_link: updated.hangout_link,
        synced_at: new Date().toISOString()
      }).eq("id", eventId);

      res.json({ ok: true, event: updated });
    } catch (err) {
      console.error("[calendar] Update event error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Delete an event.
   */
  app.delete("/api/calendar/events/:id", async (req, res) => {
    const eventId = req.params.id;
    const colonIdx = eventId.indexOf(':');
    if (colonIdx === -1) return res.status(400).json({ error: "Invalid event ID" });

    const accountId = eventId.substring(0, colonIdx);
    const googleEventId = eventId.substring(colonIdx + 1);

    try {
      const { data: dbEvent } = await db
        .from("calendar_events")
        .select("calendar_id")
        .eq("id", eventId)
        .single();

      if (!dbEvent) return res.status(404).json({ error: "Event not found" });

      const { data: account } = await db
        .from("email_accounts")
        .select("*")
        .eq("id", accountId)
        .single();

      if (!account) return res.status(404).json({ error: "Account not found" });

      const onTokenRefresh = async (newTokens) => {
        await db.from("email_accounts").update({
          tokens_encrypted: gcalClient.encrypt(JSON.stringify(newTokens)),
          updated_at: new Date().toISOString()
        }).eq("id", account.id);
      };

      const { cal } = gcalClient.createCalendarClient(account, onTokenRefresh);
      await gcalClient.deleteEvent(cal, dbEvent.calendar_id, googleEventId);

      // Remove from our DB
      await db.from("calendar_events").delete().eq("id", eventId);

      res.json({ ok: true });
    } catch (err) {
      console.error("[calendar] Delete event error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Conflicts ──────────────────────────────────────────────────────────────

  /**
   * Detect conflicts in a date range.
   */
  app.get("/api/calendar/conflicts", async (req, res) => {
    const now = new Date();
    const start = req.query.start || now.toISOString();
    const end = req.query.end || new Date(now.getTime() + 7 * 86400000).toISOString();

    try {
      const conflicts = await getConflictsForRange(db, start, end);
      res.json(conflicts);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sync Control ───────────────────────────────────────────────────────────

  /**
   * Force sync all accounts now.
   */
  app.post("/api/calendar/sync", async (_req, res) => {
    if (!scheduler) return res.status(400).json({ error: "Calendar not running" });
    try {
      const synced = await scheduler.syncNow();
      res.json({ ok: true, accounts_synced: synced });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Scheduler status.
   */
  app.get("/api/calendar/status", async (_req, res) => {
    const accounts = scheduler ? await scheduler.getEnabledAccounts() : [];

    // Check which accounts have calendar access
    const accountStatuses = [];
    for (const acct of accounts) {
      let hasCalendar = false;
      try {
        hasCalendar = scheduler ? await scheduler.checkAccess(acct) : false;
      } catch (e) { /* ignore */ }
      accountStatuses.push({
        id: acct.id,
        email: acct.email,
        label: acct.label,
        calendar_color: acct.calendar_color,
        hasCalendarAccess: hasCalendar
      });
    }

    res.json({
      running: !!scheduler?.running,
      accounts: accountStatuses,
      configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET)
    });
  });

  /**
   * Get accounts with calendar access info.
   */
  app.get("/api/calendar/accounts", async (_req, res) => {
    const { data, error } = await db
      .from("email_accounts")
      .select("id, label, email, enabled, calendar_color, created_at")
      .eq("enabled", true)
      .order("created_at");

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  /**
   * Update account calendar color.
   */
  app.patch("/api/calendar/accounts/:id", async (req, res) => {
    const updates = {};
    if (req.body.calendar_color) updates.calendar_color = req.body.calendar_color;
    updates.updated_at = new Date().toISOString();

    const { error } = await db
      .from("email_accounts")
      .update(updates)
      .eq("id", req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  /**
   * Trigger re-auth with calendar scope for an account.
   */
  app.post("/api/calendar/accounts/:id/reauth", async (req, res) => {
    try {
      const { getAuthUrl } = require("../email-synth/gmail-client");
      const { data: account } = await db
        .from("email_accounts")
        .select("label")
        .eq("id", req.params.id)
        .single();

      const label = account?.label || "personal";
      const authUrl = getAuthUrl(label);
      res.json({ authUrl });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { init, shutdown, registerRoutes };
