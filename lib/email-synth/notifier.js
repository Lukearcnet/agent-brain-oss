/**
 * Notifier — ntfy.sh push notification formatting for email alerts
 *
 * Formats and sends push notifications for urgent/today emails
 * and daily digests. Uses the existing sendPushNotification function.
 */

const CLASSIFICATION_CONFIG = {
  RESPOND_NOW: { emoji: "\u{1F534}", label: "Urgent", priority: 5, tags: "email,urgent" },
  RESPOND_TODAY: { emoji: "\u{1F7E1}", label: "Today", priority: 4, tags: "email" },
  FYI_NO_ACTION: { emoji: "\u{1F7E2}", label: "FYI", priority: 3, tags: "email,fyi" },
  IGNORE: { emoji: "\u26AB", label: "Ignore", priority: 2, tags: "email,ignore" }
};

/**
 * Format and send a push notification for a classified email.
 * @param {object} email - { from_name, from_address, subject, classification, summary }
 * @param {function} sendPush - The sendPushNotification function from server.js
 * @param {object} settings - emailSynthesizer notification settings
 */
async function notifyEmail(email, sendPush, settings = {}) {
  const config = CLASSIFICATION_CONFIG[email.classification];
  if (!config) return;

  // Only notify for configured classifications
  if (email.classification === "RESPOND_NOW" && settings.notifyRespondNow === false) return;
  if (email.classification === "RESPOND_TODAY" && settings.notifyRespondToday === false) return;
  // Never push for FYI or IGNORE
  if (email.classification === "FYI_NO_ACTION" || email.classification === "IGNORE") return;

  const senderName = email.from_name || email.from_address;
  const title = `${config.emoji} Email: ${senderName}`;
  const message = `${email.subject || "(no subject)"} \u2014 ${email.summary}`;

  await sendPush({
    title,
    message,
    priority: config.priority
  });
}

/**
 * Format and send the daily digest notification.
 * @param {object} digest - { date, stats, pendingResponses }
 * @param {function} sendPush - The sendPushNotification function
 * @param {object} settings - emailSynthesizer notification settings
 */
async function notifyDigest(digest, sendPush, settings = {}) {
  if (settings.notifyDigest === false) return;

  const { stats, pendingResponses } = digest;
  const dateStr = new Date(digest.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  let message = `Yesterday: ${stats.total} emails`;
  message += ` (${stats.respond_now}\u{1F534}, ${stats.respond_today}\u{1F7E1}, ${stats.fyi}\u{1F7E2}, ${stats.ignore}\u26AB)`;

  if (pendingResponses && pendingResponses.length > 0) {
    message += "\n\nStill needs response:";
    for (const p of pendingResponses.slice(0, 5)) {
      const name = p.from_name || p.from_address;
      message += `\n\u2022 ${name} \u2014 ${p.subject || "(no subject)"}`;
    }
    if (pendingResponses.length > 5) {
      message += `\n  +${pendingResponses.length - 5} more`;
    }
  }

  await sendPush({
    title: `\u{1F4CB} Email Digest \u2014 ${dateStr}`,
    message,
    priority: 3
  });
}

module.exports = { notifyEmail, notifyDigest, CLASSIFICATION_CONFIG };
