/**
 * Scheduler — Email polling, Pub/Sub listener, cron jobs
 *
 * Manages the lifecycle of email monitoring:
 * - Polling (primary): periodic checks via Gmail History API
 * - Pub/Sub (Phase 5): real-time notifications via pull subscription
 * - Digest cron: daily digest at configurable time
 * - Watch renewal: renew Pub/Sub watches daily
 */

const gmailClient = require("./gmail-client");
const { classifyBatch } = require("./classifier");
const { isSensitive, genericSummary } = require("./privacy");
const { notifyEmail, notifyDigest } = require("./notifier");
const { generateDigest, saveDigest } = require("./digest");

class EmailScheduler {
  constructor(db, sendPush, getSettings) {
    this.db = db;               // Supabase client
    this.sendPush = sendPush;   // sendPushNotification function
    this.getSettings = getSettings; // function returning emailSynthesizer settings
    this.pollTimers = new Map(); // accountId -> timer
    this.digestTimer = null;
    this.running = false;
  }

  /**
   * Start all scheduled jobs.
   */
  async start() {
    if (this.running) return;
    this.running = true;
    console.log("[email-synth] Scheduler starting...");

    // Load all enabled accounts and start polling
    const accounts = await this.getEnabledAccounts();
    for (const account of accounts) {
      this.startPolling(account);
    }

    // Start digest cron
    this.startDigestCron();

    console.log(`[email-synth] Monitoring ${accounts.length} account(s)`);
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
    if (this.digestTimer) {
      clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
    console.log("[email-synth] Scheduler stopped");
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
      console.error("[email-synth] Failed to load accounts:", error.message);
      return [];
    }
    return data || [];
  }

  /**
   * Start polling for a single account.
   */
  startPolling(account) {
    if (!this.running) return;

    const poll = async () => {
      if (!this.running) return;
      try {
        await this.checkAccount(account);
      } catch (err) {
        console.error(`[email-synth] Poll error (${account.email}):`, err.message);

        // Detect token expiry
        if (err.message?.includes("invalid_grant") || err.code === 401) {
          console.warn(`[email-synth] Token expired for ${account.email} — needs re-authorization`);
          await this.sendPush({
            title: "\u26A0\uFE0F Email: Re-auth Required",
            message: `Gmail token expired for ${account.email}. Re-authorize in the dashboard.`,
            priority: 4
          });
          return; // Don't reschedule
        }
      }

      // Schedule next poll
      if (this.running) {
        const interval = this.getPollingInterval();
        const timer = setTimeout(poll, interval);
        this.pollTimers.set(account.id, timer);
      }
    };

    // Initial poll immediately
    poll();
  }

  /**
   * Get the adaptive polling interval based on time of day.
   */
  getPollingInterval() {
    const settings = this.getSettings();
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay(); // 0=Sun, 6=Sat

    const bizStart = settings.businessHoursStart ?? 8;
    const bizEnd = settings.businessHoursEnd ?? 18;
    const isBusinessHours = day >= 1 && day <= 5 && hour >= bizStart && hour < bizEnd;

    return isBusinessHours
      ? (settings.pollIntervalBusinessHours || 1800000)   // 30 min
      : (settings.pollIntervalOffHours || 3600000);        // 60 min
  }

  /**
   * Check a single account for new emails, classify, and notify.
   */
  async checkAccount(account) {
    // Reload account to get latest historyId
    const { data: freshAccount } = await this.db
      .from("email_accounts")
      .select("*")
      .eq("id", account.id)
      .single();

    if (!freshAccount || !freshAccount.enabled) return;

    const onTokenRefresh = async (newTokens) => {
      await this.db
        .from("email_accounts")
        .update({
          tokens_encrypted: gmailClient.encrypt(JSON.stringify(newTokens)),
          updated_at: new Date().toISOString()
        })
        .eq("id", account.id);
    };

    const { gmail } = gmailClient.createGmailClient(freshAccount, onTokenRefresh);

    let messageIds;
    let newHistoryId;

    if (!freshAccount.history_id) {
      // First sync — get profile historyId and recent messages
      console.log(`[email-synth] Initial sync for ${freshAccount.email}`);
      const profile = await gmailClient.getProfile(gmail);
      newHistoryId = profile.historyId;

      const recent = await gmailClient.listRecentMessages(gmail, 25);
      messageIds = recent.map(m => m.id);
    } else {
      // Incremental sync via history
      const result = await gmailClient.getHistoryChanges(gmail, freshAccount.history_id);

      if (result.needsFullSync) {
        console.log(`[email-synth] History stale for ${freshAccount.email}, doing full sync`);
        const profile = await gmailClient.getProfile(gmail);
        newHistoryId = profile.historyId;
        const recent = await gmailClient.listRecentMessages(gmail, 25);
        messageIds = recent.map(m => m.id);
      } else {
        messageIds = result.messageIds;
        newHistoryId = result.newHistoryId;
      }
    }

    if (messageIds.length === 0) {
      // Still update historyId
      if (newHistoryId) {
        await this.db
          .from("email_accounts")
          .update({ history_id: newHistoryId, updated_at: new Date().toISOString() })
          .eq("id", account.id);
      }
      return;
    }

    // Filter out already-processed messages
    const { data: existing } = await this.db
      .from("emails")
      .select("id")
      .in("id", messageIds);
    const existingIds = new Set((existing || []).map(e => e.id));
    const newMessageIds = messageIds.filter(id => !existingIds.has(id));

    if (newMessageIds.length === 0) {
      if (newHistoryId) {
        await this.db
          .from("email_accounts")
          .update({ history_id: newHistoryId, updated_at: new Date().toISOString() })
          .eq("id", account.id);
      }
      return;
    }

    console.log(`[email-synth] ${newMessageIds.length} new email(s) for ${freshAccount.email}`);

    // Fetch full message data
    const settings = this.getSettings();
    const messages = await gmailClient.getMessages(gmail, newMessageIds, {
      maxBodyChars: settings.maxBodyChars || 500
    });

    // Filter by Gmail category
    const categoryFilter = freshAccount.category_filter || ["Primary", "Updates"];
    const filtered = messages.filter(m => categoryFilter.includes(m.gmail_category));
    const skipped = messages.filter(m => !categoryFilter.includes(m.gmail_category));

    // Auto-classify skipped (Promotions/Social) as IGNORE
    for (const msg of skipped) {
      await this.storeEmail(msg, freshAccount.id, {
        classification: "IGNORE",
        summary: `${msg.gmail_category} category email.`,
        is_sensitive: false
      });
    }

    // Separate sensitive from normal
    const sensitiveEmails = [];
    const normalEmails = [];

    for (const msg of filtered) {
      const check = isSensitive(msg, settings);
      if (check.sensitive) {
        sensitiveEmails.push({ ...msg, sensitiveReason: check.reason });
      } else {
        normalEmails.push(msg);
      }
    }

    // Handle sensitive emails locally
    for (const msg of sensitiveEmails) {
      await this.storeEmail(msg, freshAccount.id, {
        classification: "FYI_NO_ACTION",
        summary: genericSummary(msg),
        is_sensitive: true
      });
    }

    // Classify normal emails with Claude Haiku (in batches)
    const batchSize = settings.batchSize || 15;
    for (let i = 0; i < normalEmails.length; i += batchSize) {
      const batch = normalEmails.slice(i, i + batchSize);

      try {
        const results = await classifyBatch(batch, {
          model: settings.classificationModel || "claude-haiku-4-5-20251001",
          maxBodyChars: settings.maxBodyChars || 500
        });

        // Map results back to emails
        const resultMap = new Map(results.map(r => [r.email_id, r]));

        for (const msg of batch) {
          const result = resultMap.get(msg.id);
          const classification = result?.classification || "FYI_NO_ACTION";
          const summary = result?.summary || "";

          const stored = await this.storeEmail(msg, freshAccount.id, {
            classification,
            summary,
            is_sensitive: false
          });

          // Send push notification for urgent emails
          if (stored && (classification === "RESPOND_NOW" || classification === "RESPOND_TODAY")) {
            await notifyEmail({ ...msg, classification, summary }, this.sendPush, settings);
            await this.db
              .from("emails")
              .update({ notification_sent: true })
              .eq("id", msg.id);
          }
        }
      } catch (err) {
        console.error("[email-synth] Classification error:", err.message);
        // Store unclassified
        for (const msg of batch) {
          await this.storeEmail(msg, freshAccount.id, {
            classification: null,
            summary: null,
            is_sensitive: false
          });
        }
      }
    }

    // Update historyId
    if (newHistoryId) {
      await this.db
        .from("email_accounts")
        .update({ history_id: newHistoryId, updated_at: new Date().toISOString() })
        .eq("id", account.id);
    }
  }

  /**
   * Store a processed email in Supabase.
   */
  async storeEmail(msg, accountId, { classification, summary, is_sensitive }) {
    const row = {
      id: msg.id,
      account_id: accountId,
      thread_id: msg.thread_id,
      from_address: msg.from_address,
      from_name: msg.from_name,
      to_addresses: msg.to_addresses,
      cc_addresses: msg.cc_addresses,
      subject: msg.subject,
      snippet: is_sensitive ? null : (msg.snippet || ""),
      gmail_labels: msg.gmail_labels,
      received_at: msg.received_at,
      classification,
      summary,
      is_sensitive,
      notification_sent: false,
      responded: false,
      created_at: new Date().toISOString()
    };

    const { error } = await this.db
      .from("emails")
      .upsert(row, { onConflict: "id" });

    if (error) {
      console.error(`[email-synth] Failed to store email ${msg.id}:`, error.message);
      return false;
    }
    return true;
  }

  /**
   * Start the daily digest cron.
   */
  startDigestCron() {
    const scheduleNext = () => {
      if (!this.running) return;

      const settings = this.getSettings();
      const digestTime = settings.digestTime || "08:00";
      const [hour, minute] = digestTime.split(":").map(Number);

      const now = new Date();
      const next = new Date(now);
      next.setHours(hour, minute, 0, 0);

      // If the time has already passed today, schedule for tomorrow
      if (next <= now) {
        next.setDate(next.getDate() + 1);
      }

      const delay = next.getTime() - now.getTime();
      console.log(`[email-synth] Next digest at ${next.toLocaleString()} (in ${Math.round(delay / 60000)}min)`);

      this.digestTimer = setTimeout(async () => {
        await this.runDigest();
        scheduleNext(); // Reschedule for next day
      }, delay);
    };

    scheduleNext();
  }

  /**
   * Generate and send the daily digest.
   */
  async runDigest() {
    console.log("[email-synth] Generating daily digest...");
    try {
      const digest = await generateDigest(this.db);
      if (!digest || digest.stats.total === 0) {
        console.log("[email-synth] No emails yesterday, skipping digest");
        return;
      }

      await saveDigest(this.db, digest);
      const settings = this.getSettings();
      await notifyDigest(digest, this.sendPush, settings);

      // Mark digest as sent
      await this.db
        .from("email_digests")
        .update({ sent_at: new Date().toISOString() })
        .eq("digest_date", digest.digest_date);

      console.log(`[email-synth] Digest sent: ${digest.stats.total} emails, ${digest.pending_responses.length} pending`);
    } catch (err) {
      console.error("[email-synth] Digest error:", err.message);
    }
  }

  /**
   * Force a poll on all accounts (manual trigger).
   */
  async pollNow() {
    const accounts = await this.getEnabledAccounts();
    for (const account of accounts) {
      await this.checkAccount(account);
    }
    return accounts.length;
  }
}

module.exports = { EmailScheduler };
