/**
 * Gmail Client — OAuth flow, token management, Gmail API wrapper
 *
 * Handles multi-account OAuth, token encryption/decryption (reusing auth-broker pattern),
 * and Gmail API operations (list messages, get message, history sync).
 */

const { google } = require("googleapis");
const crypto = require("crypto");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events"
];
const ALGORITHM = "aes-256-gcm";

// ── Encryption (matches auth-broker.js pattern) ─────────────────────────────

function getEncKey() {
  const key = process.env.AUTH_ENCRYPTION_KEY;
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY not set");
  if (key.length === 64) return Buffer.from(key, "hex");
  if (key.length === 44) return Buffer.from(key, "base64");
  return Buffer.from(key.padEnd(32, "\0").slice(0, 32));
}

function encrypt(plaintext) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decrypt(encryptedStr) {
  const key = getEncKey();
  const [ivB64, tagB64, dataB64] = encryptedStr.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

// ── OAuth Client ────────────────────────────────────────────────────────────

function createOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || "http://localhost:3030/api/email/accounts/callback";

  if (!clientId || !clientSecret) {
    throw new Error("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in .env");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generate the OAuth consent URL for a new account.
 * @param {string} state - State parameter (account label) to pass through OAuth flow
 * @returns {string} Authorization URL
 */
function getAuthUrl(state = "") {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // Force consent to always get refresh_token
    scope: SCOPES,
    state
  });
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code - Authorization code from OAuth callback
 * @returns {object} Token object { access_token, refresh_token, expiry_date, token_type }
 */
async function exchangeCode(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Create an authenticated Gmail API client for an account.
 * @param {object} account - { tokens_encrypted } from email_accounts table
 * @param {function} onTokenRefresh - Callback when tokens are refreshed: (newTokens) => void
 * @returns {{ gmail: object, auth: object }} Gmail API client and auth object
 */
function createGmailClient(account, onTokenRefresh) {
  if (!account.tokens_encrypted) {
    throw new Error("No tokens stored for this account");
  }

  const tokens = JSON.parse(decrypt(account.tokens_encrypted));
  const auth = createOAuth2Client();
  auth.setCredentials(tokens);

  // Listen for automatic token refresh
  auth.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    if (onTokenRefresh) {
      onTokenRefresh(merged);
    }
  });

  const gmail = google.gmail({ version: "v1", auth });
  return { gmail, auth };
}

// ── Gmail API Operations ────────────────────────────────────────────────────

/**
 * Get the user's email address and current historyId.
 */
async function getProfile(gmail) {
  const res = await gmail.users.getProfile({ userId: "me" });
  return {
    email: res.data.emailAddress,
    historyId: res.data.historyId
  };
}

/**
 * Fetch incremental changes since a historyId.
 * @returns {{ messages: object[], newHistoryId: string }} New messages and updated historyId
 */
async function getHistoryChanges(gmail, startHistoryId) {
  try {
    const res = await gmail.users.history.list({
      userId: "me",
      startHistoryId,
      historyTypes: ["messageAdded"],
      labelId: "INBOX"
    });

    const history = res.data.history || [];
    const newHistoryId = res.data.historyId || startHistoryId;

    // Extract unique message IDs from messagesAdded
    const messageIds = new Set();
    for (const record of history) {
      for (const added of (record.messagesAdded || [])) {
        // Only include messages that are in INBOX
        const labels = added.message?.labelIds || [];
        if (labels.includes("INBOX")) {
          messageIds.add(added.message.id);
        }
      }
    }

    return { messageIds: [...messageIds], newHistoryId };
  } catch (err) {
    // 404 = historyId too old, need full sync
    if (err.code === 404 || err.status === 404) {
      return { messageIds: [], newHistoryId: null, needsFullSync: true };
    }
    throw err;
  }
}

/**
 * Fetch full message details for a list of message IDs.
 * @param {string[]} messageIds
 * @param {object} options - { format: "metadata"|"full", maxBodyChars }
 * @returns {object[]} Array of parsed email objects
 */
async function getMessages(gmail, messageIds, options = {}) {
  const { maxBodyChars = 500 } = options;
  const results = [];

  for (const msgId of messageIds) {
    try {
      const res = await gmail.users.messages.get({
        userId: "me",
        id: msgId,
        format: "full"
      });
      results.push(parseMessage(res.data, maxBodyChars));
    } catch (err) {
      console.error(`[gmail] Failed to fetch message ${msgId}:`, err.message);
    }
  }

  return results;
}

/**
 * List recent INBOX messages (for initial sync or full resync).
 * @returns {object[]} Array of { id, threadId }
 */
async function listRecentMessages(gmail, maxResults = 50) {
  const res = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults
  });
  return res.data.messages || [];
}

/**
 * Set up a Pub/Sub watch on the user's mailbox.
 * @param {string} topicName - Full Pub/Sub topic path
 * @returns {{ historyId: string, expiration: number }}
 */
async function setupWatch(gmail, topicName) {
  const res = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "include"
    }
  });
  return {
    historyId: res.data.historyId,
    expiration: parseInt(res.data.expiration)
  };
}

/**
 * Stop a Pub/Sub watch.
 */
async function stopWatch(gmail) {
  await gmail.users.stop({ userId: "me" });
}

// ── Message Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a raw Gmail message into a clean object.
 */
function parseMessage(msg, maxBodyChars = 500) {
  const headers = msg.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  const from = getHeader("From");
  const { name: fromName, address: fromAddress } = parseEmailAddress(from);

  const toRaw = getHeader("To");
  const ccRaw = getHeader("Cc");

  return {
    id: msg.id,
    thread_id: msg.threadId,
    from_address: fromAddress,
    from_name: fromName,
    to_addresses: parseAddressList(toRaw),
    cc_addresses: parseAddressList(ccRaw),
    subject: getHeader("Subject"),
    snippet: extractPlainTextBody(msg.payload, maxBodyChars) || msg.snippet || "",
    gmail_labels: msg.labelIds || [],
    received_at: new Date(parseInt(msg.internalDate)).toISOString(),
    gmail_category: detectCategory(msg.labelIds || [])
  };
}

/**
 * Parse "Name <email>" format, or plain email addresses.
 * Handles: "Name" <email>, Name <email>, <email>, plain@email.com, "plain@email.com"
 */
function parseEmailAddress(raw) {
  if (!raw) return { name: "", address: "" };

  // Format with angle brackets: "Name" <email> or Name <email> or <email>
  const angleMatch = raw.match(/<([^>]+)>/);
  if (angleMatch) {
    const namePart = raw.substring(0, raw.indexOf("<")).replace(/^["'\s]+|["'\s]+$/g, "");
    return { name: namePart, address: angleMatch[1].trim().toLowerCase() };
  }

  // Plain email address (possibly wrapped in quotes)
  const plain = raw.replace(/^["'\s]+|["'\s]+$/g, "").trim();
  return { name: "", address: plain.toLowerCase() };
}

/**
 * Parse a comma-separated list of email addresses.
 */
function parseAddressList(raw) {
  if (!raw) return [];
  return raw.split(",").map(addr => {
    const { address } = parseEmailAddress(addr.trim());
    return address;
  }).filter(Boolean);
}

/**
 * Extract plain text body from a MIME message, truncated.
 */
function extractPlainTextBody(payload, maxChars = 500) {
  if (!payload) return "";

  // Direct body
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString("utf8");
    return decoded.slice(0, maxChars);
  }

  // Multipart — look for text/plain in parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        const decoded = Buffer.from(part.body.data, "base64url").toString("utf8");
        return decoded.slice(0, maxChars);
      }
      // Recurse into nested multipart
      if (part.parts) {
        const nested = extractPlainTextBody(part, maxChars);
        if (nested) return nested;
      }
    }
  }

  return "";
}

/**
 * Detect Gmail category from labels.
 */
function detectCategory(labels) {
  if (labels.includes("CATEGORY_PROMOTIONS")) return "Promotions";
  if (labels.includes("CATEGORY_SOCIAL")) return "Social";
  if (labels.includes("CATEGORY_UPDATES")) return "Updates";
  if (labels.includes("CATEGORY_FORUMS")) return "Forums";
  if (labels.includes("CATEGORY_PERSONAL")) return "Primary";
  // Default to Primary if no category label
  return "Primary";
}

// ── Full Message (for reading pane) ────────────────────────────────────────

/**
 * Fetch the full message from Gmail API with HTML body.
 * Used on-demand when a user opens an email (not stored in DB).
 */
async function getFullMessage(gmail, messageId) {
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full"
  });
  const msg = res.data;
  const headers = msg.payload?.headers || [];
  const getHeader = (name) =>
    headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";

  return {
    id: msg.id,
    threadId: msg.threadId,
    from: parseEmailAddress(getHeader("From")),
    to: parseAddressList(getHeader("To")),
    cc: parseAddressList(getHeader("Cc")),
    subject: getHeader("Subject"),
    date: getHeader("Date"),
    messageId: getHeader("Message-ID"),
    references: getHeader("References"),
    inReplyTo: getHeader("In-Reply-To"),
    htmlBody: extractHtmlBody(msg.payload),
    textBody: extractPlainTextBody(msg.payload, 100000),
    labelIds: msg.labelIds || []
  };
}

/**
 * Extract HTML body from a MIME message.
 * Recursively searches multipart structure for text/html parts.
 */
function extractHtmlBody(payload) {
  if (!payload) return "";

  if (payload.mimeType === "text/html" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
      }
      if (part.mimeType?.startsWith("multipart/") || part.parts) {
        const html = extractHtmlBody(part);
        if (html) return html;
      }
    }
  }

  return "";
}

// ── Sent & Drafts ───────────────────────────────────────────────────────────

/**
 * List sent messages from Gmail API (on-demand, not stored in DB).
 * Returns lightweight message objects with headers + snippet.
 */
async function listSentMessages(gmail, maxResults = 30) {
  const res = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["SENT"],
    maxResults
  });
  const messages = res.data.messages || [];
  const detailed = await Promise.all(messages.map(async m => {
    try {
      const msg = await gmail.users.messages.get({
        userId: "me", id: m.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Cc", "Subject", "Date"]
      });
      const headers = msg.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
      const from = parseEmailAddress(getHeader("From"));
      return {
        id: msg.data.id,
        threadId: msg.data.threadId,
        from_name: from.name,
        from_address: from.address,
        to_addresses: parseAddressList(getHeader("To")),
        cc_addresses: parseAddressList(getHeader("Cc")),
        subject: getHeader("Subject"),
        received_at: new Date(parseInt(msg.data.internalDate)).toISOString(),
        snippet: msg.data.snippet || ""
      };
    } catch (e) {
      console.error(`[gmail] Failed to fetch sent msg ${m.id}:`, e.message);
      return null;
    }
  }));
  return detailed.filter(Boolean);
}

/**
 * List drafts from Gmail API (on-demand, not stored in DB).
 */
async function listDrafts(gmail, maxResults = 20) {
  const res = await gmail.users.drafts.list({
    userId: "me",
    maxResults
  });
  const drafts = res.data.drafts || [];
  const detailed = await Promise.all(drafts.map(async d => {
    try {
      const draft = await gmail.users.drafts.get({
        userId: "me", id: d.id, format: "metadata"
      });
      const msg = draft.data.message;
      const headers = msg?.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || "";
      return {
        id: msg?.id,
        draftId: d.id,
        threadId: msg?.threadId,
        to_addresses: parseAddressList(getHeader("To")),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
        received_at: msg?.internalDate ? new Date(parseInt(msg.internalDate)).toISOString() : new Date().toISOString(),
        snippet: msg?.snippet || ""
      };
    } catch (e) {
      console.error(`[gmail] Failed to fetch draft ${d.id}:`, e.message);
      return null;
    }
  }));
  return detailed.filter(Boolean);
}

// ── Send Email ──────────────────────────────────────────────────────────────

/**
 * Send an email via Gmail API.
 * Constructs a raw MIME message and sends it.
 * For replies, include inReplyTo, references, and threadId.
 */
async function sendMessage(gmail, { to, from, cc, bcc, subject, body, inReplyTo, references, threadId }) {
  const lines = [];
  if (from) lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (cc) lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${subject}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/html; charset=utf-8");
  lines.push("");
  lines.push(body);

  const raw = Buffer.from(lines.join("\r\n")).toString("base64url");
  const params = { userId: "me", requestBody: { raw } };
  if (threadId) params.requestBody.threadId = threadId;

  const res = await gmail.users.messages.send(params);
  return res.data;
}

module.exports = {
  createOAuth2Client,
  getAuthUrl,
  exchangeCode,
  createGmailClient,
  getProfile,
  getHistoryChanges,
  getMessages,
  getFullMessage,
  listRecentMessages,
  setupWatch,
  stopWatch,
  parseMessage,
  sendMessage,
  listSentMessages,
  listDrafts,
  extractHtmlBody,
  encrypt,
  decrypt
};
