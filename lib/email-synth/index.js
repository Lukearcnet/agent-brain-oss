/**
 * Email Synthesizer — Module entry point
 *
 * Initializes the email monitoring system and exports route handlers
 * for integration with the Agent Brain Express server.
 */

const gmailClient = require("./gmail-client");
const { EmailScheduler } = require("./scheduler");
const { generateDigest, saveDigest, getDigest } = require("./digest");
const { getGoogleContacts } = require("./google-contacts");

let scheduler = null;
const CONTACT_CACHE_TTL_MS = 5 * 60 * 1000;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function addContactAggregate(map, email, meta = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes("@")) return;

  const existing = map.get(normalized) || {
    email: normalized,
    names: new Set(),
    accounts: new Set(),
    count: 0,
    lastSeenAt: null
  };

  if (meta.name) existing.names.add(String(meta.name).trim());
  if (meta.accountId) existing.accounts.add(meta.accountId);
  existing.count += 1;

  if (meta.seenAt) {
    const seenAt = new Date(meta.seenAt).toISOString();
    if (!existing.lastSeenAt || seenAt > existing.lastSeenAt) {
      existing.lastSeenAt = seenAt;
    }
  }

  map.set(normalized, existing);
}

function collectContactsFromMessage(map, message) {
  const baseMeta = {
    accountId: message.account_id || message.accountId || null,
    seenAt: message.received_at || message.date || null
  };

  addContactAggregate(map, message.from_address, { ...baseMeta, name: message.from_name });
  (message.to_addresses || []).forEach(email => addContactAggregate(map, email, baseMeta));
  (message.cc_addresses || []).forEach(email => addContactAggregate(map, email, baseMeta));
}

function finalizeContacts(map, googleContacts) {
  // Merge Google contacts into the map (add contacts not seen in email)
  if (googleContacts && googleContacts.size > 0) {
    for (const [email, { name }] of googleContacts) {
      if (!map.has(email)) {
        map.set(email, {
          email,
          names: new Set(name ? [name] : []),
          accounts: new Set(),
          count: 0,
          lastSeenAt: null,
        });
      }
    }
  }

  return [...map.values()]
    .map(contact => {
      // Prefer Google name if available (usually more complete/accurate)
      const googleEntry = googleContacts && googleContacts.get(contact.email);
      const googleName = googleEntry ? googleEntry.name : "";
      const emailName = [...contact.names].sort((a, b) => b.length - a.length)[0] || "";
      const name = googleName || emailName;

      return {
        email: contact.email,
        name,
        count: contact.count,
        last_seen_at: contact.lastSeenAt,
        account_ids: [...contact.accounts],
      };
    })
    .sort((a, b) => {
      if ((b.count || 0) !== (a.count || 0)) return (b.count || 0) - (a.count || 0);
      return new Date(b.last_seen_at || 0) - new Date(a.last_seen_at || 0);
    });
}

/**
 * Initialize the email synthesizer module.
 * Call this from server.js after settings are loaded.
 */
function init(db, sendPush, getSettings) {
  const settings = getSettings();
  if (!settings.enabled) {
    console.log("[email-synth] Disabled in settings");
    return;
  }

  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    console.log("[email-synth] GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET not set — skipping");
    return;
  }

  scheduler = new EmailScheduler(db, sendPush, getSettings);
  scheduler.start().catch(err => {
    console.error("[email-synth] Failed to start scheduler:", err.message);
  });

  console.log("[email-synth] Module initialized");
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
function shutdown() {
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
}

/**
 * Register all email synthesizer routes on the Express app.
 */
function registerRoutes(app, db, sendPush, getSettings) {
  let contactsCache = { value: null, expiresAt: 0 };

  // ── Account Management ──────────────────────────────────────────────────

  // List all email accounts
  app.get("/api/email/accounts", async (_req, res) => {
    const { data, error } = await db
      .from("email_accounts")
      .select("id, label, email, enabled, calendar_color, history_id, watch_expiration, category_filter, created_at, updated_at")
      .order("created_at");

    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // Start OAuth flow — returns auth URL
  app.post("/api/email/accounts", (req, res) => {
    const label = req.body.label || "personal";
    try {
      const authUrl = gmailClient.getAuthUrl(label);
      res.json({ authUrl, label });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // OAuth callback
  app.get("/api/email/accounts/callback", async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing authorization code");

    try {
      const tokens = await gmailClient.exchangeCode(code);

      // Get email address from the tokens
      const auth = gmailClient.createOAuth2Client();
      auth.setCredentials(tokens);
      const gmail = require("googleapis").google.gmail({ version: "v1", auth });
      const profile = await gmail.users.getProfile({ userId: "me" });
      const email = profile.data.emailAddress;
      const historyId = profile.data.historyId;

      // Check if account already exists (re-auth flow)
      const { data: existing } = await db
        .from("email_accounts")
        .select("id")
        .eq("email", email)
        .single();

      let error;
      if (existing) {
        // Re-auth: just update tokens on existing account (preserves FK references)
        ({ error } = await db
          .from("email_accounts")
          .update({
            tokens_encrypted: gmailClient.encrypt(JSON.stringify(tokens)),
            history_id: historyId,
            label: state || undefined,
            enabled: true,
            updated_at: new Date().toISOString()
          })
          .eq("id", existing.id));
      } else {
        // New account
        ({ error } = await db
          .from("email_accounts")
          .insert({
            id: `acct-${Date.now()}`,
            label: state || "personal",
            email,
            tokens_encrypted: gmailClient.encrypt(JSON.stringify(tokens)),
            history_id: historyId,
            enabled: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          }));
      }

      if (error) {
        return res.status(500).send(`Failed to save account: ${error.message}`);
      }

      // Restart scheduler to pick up new account
      if (scheduler) {
        scheduler.stop();
        scheduler.start().catch(console.error);
      }

      res.type("html").send(`
        <html><body style="font-family:system-ui;text-align:center;padding:60px">
          <h2>Gmail Connected!</h2>
          <p>${email} linked as <strong>${state || "personal"}</strong></p>
          <p>You can close this tab.</p>
          <script>setTimeout(() => window.close(), 3000)</script>
        </body></html>
      `);
    } catch (err) {
      console.error("[email-synth] OAuth callback error:", err.message);
      res.status(500).send(`Authorization failed: ${err.message}`);
    }
  });

  // Delete an account
  app.delete("/api/email/accounts/:id", async (req, res) => {
    const { error } = await db
      .from("email_accounts")
      .delete()
      .eq("id", req.params.id);

    if (error) return res.status(500).json({ error: error.message });

    // Restart scheduler
    if (scheduler) {
      scheduler.stop();
      scheduler.start().catch(console.error);
    }

    res.json({ ok: true });
  });

  // Toggle account enabled/disabled
  app.patch("/api/email/accounts/:id", async (req, res) => {
    const updates = {};
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
    if (req.body.label) updates.label = req.body.label;
    if (req.body.category_filter) updates.category_filter = req.body.category_filter;
    updates.updated_at = new Date().toISOString();

    const { error } = await db
      .from("email_accounts")
      .update(updates)
      .eq("id", req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // ── Email Inbox ────────────────────────────────────────────────────────

  // List emails with filters (includes account info for color coding)
  app.get("/api/email/inbox", async (req, res) => {
    const { classification, account, since, limit = "50", responded } = req.query;

    let query = db
      .from("emails")
      .select("*, email_accounts(label, email, calendar_color)")
      .order("received_at", { ascending: false })
      .limit(parseInt(limit));

    if (classification) query = query.eq("classification", classification);
    if (account) query = query.eq("account_id", account);
    if (since) query = query.gte("received_at", since);
    if (responded === "true") query = query.eq("responded", true);
    if (responded === "false") query = query.eq("responded", false);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  // Mark email as responded
  app.post("/api/email/inbox/:id/responded", async (req, res) => {
    const { error } = await db
      .from("emails")
      .update({ responded: true })
      .eq("id", req.params.id);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  // Force re-classify specific emails
  app.post("/api/email/classify", async (req, res) => {
    const { email_ids } = req.body;
    if (!email_ids || !Array.isArray(email_ids)) {
      return res.status(400).json({ error: "email_ids array required" });
    }

    const { data: emails, error } = await db
      .from("emails")
      .select("*")
      .in("id", email_ids);

    if (error) return res.status(500).json({ error: error.message });

    const { classifyBatch } = require("./classifier");
    const settings = getSettings();

    try {
      const results = await classifyBatch(emails, {
        model: settings.classificationModel,
        maxBodyChars: settings.maxBodyChars
      });

      for (const r of results) {
        await db
          .from("emails")
          .update({ classification: r.classification, summary: r.summary })
          .eq("id", r.email_id);
      }

      res.json({ classified: results.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Full Message & Send ──────────────────────────────────────────────────

  /**
   * Get full email body (fetches from Gmail API on demand).
   * Returns HTML body for rendering in reading pane.
   */
  app.get("/api/email/inbox/:id/full", async (req, res) => {
    const emailId = req.params.id;

    const { data: email, error: emailErr } = await db
      .from("emails")
      .select("*, email_accounts(id, email, label, calendar_color, tokens_encrypted)")
      .eq("id", emailId)
      .single();

    if (emailErr || !email) return res.status(404).json({ error: "Email not found" });

    try {
      const account = email.email_accounts;
      const onTokenRefresh = async (newTokens) => {
        await db.from("email_accounts").update({
          tokens_encrypted: gmailClient.encrypt(JSON.stringify(newTokens)),
          updated_at: new Date().toISOString()
        }).eq("id", account.id);
      };

      const { gmail } = gmailClient.createGmailClient(account, onTokenRefresh);
      const full = await gmailClient.getFullMessage(gmail, emailId);

      res.json({
        ...email,
        email_accounts: { id: account.id, email: account.email, label: account.label, calendar_color: account.calendar_color },
        htmlBody: full.htmlBody,
        textBody: full.textBody,
        messageId: full.messageId,
        references: full.references,
        inReplyTo: full.inReplyTo,
        fullFrom: full.from,
        fullTo: full.to,
        fullCc: full.cc
      });
    } catch (err) {
      console.error("[email] Get full message error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Send an email.
   * For replies: include inReplyTo, references, threadId from the original.
   */
  app.post("/api/email/send", async (req, res) => {
    const { account_id, to, cc, bcc, subject, body, inReplyTo, references, threadId } = req.body;

    if (!account_id || !to || !subject) {
      return res.status(400).json({ error: "account_id, to, and subject are required" });
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
          tokens_encrypted: gmailClient.encrypt(JSON.stringify(newTokens)),
          updated_at: new Date().toISOString()
        }).eq("id", account.id);
      };

      const { gmail } = gmailClient.createGmailClient(account, onTokenRefresh);
      const result = await gmailClient.sendMessage(gmail, {
        from: account.email,
        to, cc, bcc, subject, body,
        inReplyTo, references, threadId
      });

      contactsCache.expiresAt = 0;

      res.json({ ok: true, messageId: result.id, threadId: result.threadId });
    } catch (err) {
      console.error("[email] Send error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sent & Drafts (live from Gmail API) ─────────────────────────────────

  /**
   * List sent messages across all accounts (or filtered by account_id).
   * Fetched directly from Gmail API on demand.
   */
  app.get("/api/email/sent", async (req, res) => {
    const { account: accountFilter, limit = "20" } = req.query;
    const maxPerAccount = parseInt(limit);

    try {
      let query = db.from("email_accounts").select("id, email, label, calendar_color, tokens_encrypted").eq("enabled", true);
      if (accountFilter) query = query.eq("id", accountFilter);
      const { data: accounts, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      const allSent = [];
      await Promise.all((accounts || []).map(async (acct) => {
        try {
          const onTokenRefresh = async (newTokens) => {
            await db.from("email_accounts").update({
              tokens_encrypted: gmailClient.encrypt(JSON.stringify(newTokens)),
              updated_at: new Date().toISOString()
            }).eq("id", acct.id);
          };
          const { gmail } = gmailClient.createGmailClient(acct, onTokenRefresh);
          const msgs = await gmailClient.listSentMessages(gmail, maxPerAccount);
          msgs.forEach(m => {
            m.account_id = acct.id;
            m.email_accounts = { label: acct.label, email: acct.email, calendar_color: acct.calendar_color };
          });
          allSent.push(...msgs);
        } catch (e) {
          console.error(`[email] Sent fetch error for ${acct.email}:`, e.message);
        }
      }));

      allSent.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
      res.json(allSent.slice(0, maxPerAccount * 2));
    } catch (err) {
      console.error("[email] Sent route error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * List drafts across all accounts (or filtered by account_id).
   */
  app.get("/api/email/drafts", async (req, res) => {
    const { account: accountFilter, limit = "20" } = req.query;
    const maxPerAccount = parseInt(limit);

    try {
      let query = db.from("email_accounts").select("id, email, label, calendar_color, tokens_encrypted").eq("enabled", true);
      if (accountFilter) query = query.eq("id", accountFilter);
      const { data: accounts, error } = await query;
      if (error) return res.status(500).json({ error: error.message });

      const allDrafts = [];
      await Promise.all((accounts || []).map(async (acct) => {
        try {
          const onTokenRefresh = async (newTokens) => {
            await db.from("email_accounts").update({
              tokens_encrypted: gmailClient.encrypt(JSON.stringify(newTokens)),
              updated_at: new Date().toISOString()
            }).eq("id", acct.id);
          };
          const { gmail } = gmailClient.createGmailClient(acct, onTokenRefresh);
          const drafts = await gmailClient.listDrafts(gmail, maxPerAccount);
          drafts.forEach(d => {
            d.account_id = acct.id;
            d.email_accounts = { label: acct.label, email: acct.email, calendar_color: acct.calendar_color };
          });
          allDrafts.push(...drafts);
        } catch (e) {
          console.error(`[email] Drafts fetch error for ${acct.email}:`, e.message);
        }
      }));

      allDrafts.sort((a, b) => new Date(b.received_at) - new Date(a.received_at));
      res.json(allDrafts.slice(0, maxPerAccount * 2));
    } catch (err) {
      console.error("[email] Drafts route error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/email/contacts", async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(parseInt(req.query.limit || "12", 10) || 12, 200));

    try {
      let contacts = contactsCache.value;
      const now = Date.now();

      if (!contacts || contactsCache.expiresAt <= now) {
        const contactMap = new Map();

        const { data: inboxRows, error: inboxError } = await db
          .from("emails")
          .select("account_id, from_name, from_address, to_addresses, cc_addresses, received_at")
          .order("received_at", { ascending: false })
          .limit(1500);

        if (inboxError) {
          return res.status(500).json({ error: inboxError.message });
        }

        (inboxRows || []).forEach(row => collectContactsFromMessage(contactMap, row));

        const { data: accounts, error: accountError } = await db
          .from("email_accounts")
          .select("id, email, label, tokens_encrypted")
          .eq("enabled", true);

        if (accountError) {
          return res.status(500).json({ error: accountError.message });
        }

        const [, googleContacts] = await Promise.all([
          Promise.all((accounts || []).map(async (acct) => {
            try {
              const onTokenRefresh = async (newTokens) => {
                await db.from("email_accounts").update({
                  tokens_encrypted: gmailClient.encrypt(JSON.stringify(newTokens)),
                  updated_at: new Date().toISOString()
                }).eq("id", acct.id);
              };
              const { gmail } = gmailClient.createGmailClient(acct, onTokenRefresh);
              const sent = await gmailClient.listSentMessages(gmail, 75);
              sent.forEach(msg => collectContactsFromMessage(contactMap, { ...msg, account_id: acct.id }));
            } catch (err) {
              console.error(`[email] Contacts sent aggregation failed for ${acct.email}:`, err.message);
            }
          })),
          getGoogleContacts(),
        ]);

        contacts = finalizeContacts(contactMap, googleContacts);
        contactsCache = {
          value: contacts,
          expiresAt: now + CONTACT_CACHE_TTL_MS
        };
      }

      let filtered = contacts;
      if (q) {
        filtered = contacts.filter(contact => {
          const haystack = `${contact.name} ${contact.email}`.toLowerCase();
          return haystack.includes(q);
        });
      }

      res.json(filtered.slice(0, limit));
    } catch (err) {
      console.error("[email] Contacts route error:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Digest ──────────────────────────────────────────────────────────────

  // Get a digest
  app.get("/api/email/digest", async (req, res) => {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const digest = await getDigest(db, date);
    if (!digest) {
      // Generate on the fly
      const fresh = await generateDigest(db, date);
      if (!fresh) return res.json({ digest_date: date, content: "No emails for this date.", stats: {} });
      return res.json(fresh);
    }
    res.json(digest);
  });

  // Force generate digest
  app.post("/api/email/digest/generate", async (req, res) => {
    const date = req.body.date;
    try {
      const digest = await generateDigest(db, date);
      if (!digest) return res.json({ message: "No emails for this date" });
      await saveDigest(db, digest);

      if (req.body.notify) {
        const { notifyDigest: nd } = require("./notifier");
        await nd(digest, sendPush, getSettings());
      }

      res.json(digest);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Stats & Control ──────────────────────────────────────────────────────

  // Email stats
  app.get("/api/email/stats", async (req, res) => {
    const { data, error } = await db
      .from("emails")
      .select("classification, responded, is_sensitive, received_at");

    if (error) return res.status(500).json({ error: error.message });

    const emails = data || [];
    const stats = {
      total: emails.length,
      respond_now: emails.filter(e => e.classification === "RESPOND_NOW").length,
      respond_today: emails.filter(e => e.classification === "RESPOND_TODAY").length,
      fyi: emails.filter(e => e.classification === "FYI_NO_ACTION").length,
      ignore: emails.filter(e => e.classification === "IGNORE").length,
      unclassified: emails.filter(e => !e.classification).length,
      pending_response: emails.filter(e =>
        (e.classification === "RESPOND_NOW" || e.classification === "RESPOND_TODAY") && !e.responded
      ).length,
      sensitive: emails.filter(e => e.is_sensitive).length
    };

    res.json(stats);
  });

  // Force poll now
  app.post("/api/email/poll", async (_req, res) => {
    if (!scheduler) return res.status(400).json({ error: "Email synthesizer not running" });
    try {
      const count = await scheduler.pollNow();
      res.json({ ok: true, accounts_polled: count });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Scheduler status
  app.get("/api/email/status", async (_req, res) => {
    const accounts = scheduler ? await scheduler.getEnabledAccounts() : [];
    res.json({
      running: !!scheduler?.running,
      accounts: accounts.length,
      configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET)
    });
  });
}

module.exports = { init, shutdown, registerRoutes };
