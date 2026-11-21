/**
 * Calendar Scheduler — Sync engine for multi-account calendar polling
 *
 * Manages the lifecycle of calendar monitoring:
 * - Per-account polling with adaptive intervals
 * - Incremental sync via Google Calendar syncToken
 * - Upcoming meeting notification cron (every 5 min)
 * - Cross-account conflict detection
 */

const gcalClient = require("./gcal-client");
const { checkUpcomingMeetings } = require("./notifier");
const { detectConflicts } = require("./conflict");

class CalendarScheduler {
  constructor(db, sendPush, getSettings) {
    this.db = db;
    this.sendPush = sendPush;
    this.getSettings = getSettings;
    this.pollTimers = new Map();   // accountId -> timer
    this.notifyTimer = null;       // 5-min meeting notification cron
    this.running = false;
  }

  /**
   * Start all scheduled jobs.
   */
  async start() {
    if (this.running) return;
    this.running = true;
    console.log("[calendar] Scheduler starting...");

    const accounts = await this.getEnabledAccounts();
    let calendarReady = 0;

    for (const account of accounts) {
      // Check if account has calendar scope
      const hasAccess = await this.checkAccess(account);
      if (hasAccess) {
        this.startPolling(account);
        calendarReady++;
      } else {
        console.log(`[calendar] ${account.email} needs re-auth for calendar scope`);
      }
    }

    // Start meeting notification cron
    this.startNotifyCron();

    console.log(`[calendar] Monitoring ${calendarReady} of ${accounts.length} account(s)`);
  }

  /**
   * Stop all scheduled jobs.
   */
  stop() {
    this.running = false;
    for (const [id, timer] of this.pollTimers) {
      clearTimeout(timer);
      this.pollTimers.delete(id);
    }
    if (this.notifyTimer) {
      clearInterval(this.notifyTimer);
      this.notifyTimer = null;
    }
    console.log("[calendar] Scheduler stopped");
  }

  /**
   * Get all enabled email accounts.
   */
  async getEnabledAccounts() {
    const { data, error } = await this.db
      .from("email_accounts")
      .select("*")
      .eq("enabled", true);
    if (error) {
      console.error("[calendar] Failed to load accounts:", error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Check if an account has calendar API access.
   */
  async checkAccess(account) {
    try {
      const onTokenRefresh = async (newTokens) => {
        await this.db
          .from("email_accounts")
          .update({
            tokens_encrypted: gcalClient.encrypt(JSON.stringify(newTokens)),
            updated_at: new Date().toISOString()
          })
          .eq("id", account.id);
      };
      return await gcalClient.checkCalendarAccess(account, onTokenRefresh);
    } catch (err) {
      console.error(`[calendar] Access check failed for ${account.email}:`, err.message);
      return false;
    }
  }

  /**
   * Start polling for a single account.
   */
  startPolling(account) {
    if (!this.running) return;

    const poll = async () => {
      if (!this.running) return;
      try {
        await this.syncAccount(account);
      } catch (err) {
        console.error(`[calendar] Sync error (${account.email}):`, err.message);

        if (err.message?.includes("invalid_grant") || err.code === 401) {
          console.warn(`[calendar] Token expired for ${account.email}`);
          await this.sendPush({
            title: "⚠️ Calendar: Re-auth Required",
            message: `Token expired for ${account.email}. Re-authorize in the dashboard.`,
            priority: 4
          });
          return; // Don't reschedule
        }
      }

      if (this.running) {
        const interval = this.getPollingInterval();
        const timer = setTimeout(poll, interval);
        this.pollTimers.set(account.id, timer);
      }
    };

    poll();
  }

  /**
   * Get adaptive polling interval.
   */
  getPollingInterval() {
    const settings = this.getSettings();
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    const bizStart = settings.businessHoursStart ?? 8;
    const bizEnd = settings.businessHoursEnd ?? 18;
    const isBusinessHours = day >= 1 && day <= 5 && hour >= bizStart && hour < bizEnd;

    return isBusinessHours
      ? (settings.pollIntervalBusinessHours || 900000)    // 15 min
      : (settings.pollIntervalOffHours || 3600000);        // 60 min
  }

  /**
   * Sync all calendars for a single account.
   */
  async syncAccount(account) {
    const onTokenRefresh = async (newTokens) => {
      await this.db
        .from("email_accounts")
        .update({
          tokens_encrypted: gcalClient.encrypt(JSON.stringify(newTokens)),
          updated_at: new Date().toISOString()
        })
        .eq("id", account.id);
    };

    const { cal } = gcalClient.createCalendarClient(account, onTokenRefresh);

    // List all calendars for this account
    const calendars = await gcalClient.listCalendars(cal);
    const settings = this.getSettings();

    let totalEvents = 0;

    for (const calendar of calendars) {
      // Get sync state for this calendar
      const { data: syncState } = await this.db
        .from("calendar_sync_state")
        .select("sync_token")
        .eq("account_id", account.id)
        .eq("calendar_id", calendar.id)
        .single();

      const syncToken = syncState?.sync_token || null;

      // Sync events
      const result = await gcalClient.syncEvents(cal, calendar.id, {
        syncToken,
        syncWindowDays: settings.syncWindowDays || 14
      });

      // Upsert events
      for (const event of result.events) {
        const compositeId = `${account.id}:${event.google_event_id}`;

        if (event.status === "cancelled") {
          // Delete cancelled events
          await this.db
            .from("calendar_events")
            .delete()
            .eq("id", compositeId);
          continue;
        }

        await this.db
          .from("calendar_events")
          .upsert({
            id: compositeId,
            account_id: account.id,
            calendar_id: calendar.id,
            calendar_name: calendar.summary,
            title: event.title,
            description: event.description,
            location: event.location,
            start_time: event.start_time,
            end_time: event.end_time,
            all_day: event.all_day,
            status: event.status,
            organizer: event.organizer,
            attendees: event.attendees,
            hangout_link: event.hangout_link,
            recurring_event_id: event.recurring_event_id,
            color_id: event.color_id,
            notification_sent: false,
            synced_at: new Date().toISOString()
          }, { onConflict: "id" });

        totalEvents++;
      }

      // Update sync token
      await this.db
        .from("calendar_sync_state")
        .upsert({
          account_id: account.id,
          calendar_id: calendar.id,
          sync_token: result.nextSyncToken,
          last_synced_at: new Date().toISOString()
        });
    }

    if (totalEvents > 0) {
      console.log(`[calendar] Synced ${totalEvents} event(s) for ${account.email}`);
    }
  }

  /**
   * Start the 5-minute notification cron for upcoming meetings.
   */
  startNotifyCron() {
    const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

    this.notifyTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        const settings = this.getSettings();
        await checkUpcomingMeetings(this.db, this.sendPush, settings);
      } catch (err) {
        console.error("[calendar] Notification cron error:", err.message);
      }
    }, CHECK_INTERVAL);

    // Also check immediately on start
    checkUpcomingMeetings(this.db, this.sendPush, this.getSettings()).catch(err => {
      console.error("[calendar] Initial notification check error:", err.message);
    });
  }

  /**
   * Force sync all accounts (manual trigger).
   */
  async syncNow() {
    const accounts = await this.getEnabledAccounts();
    let synced = 0;

    for (const account of accounts) {
      try {
        const hasAccess = await this.checkAccess(account);
        if (hasAccess) {
          await this.syncAccount(account);
          synced++;
        }
      } catch (err) {
        console.error(`[calendar] Force sync error (${account.email}):`, err.message);
      }
    }

    return synced;
  }
}

module.exports = { CalendarScheduler };
