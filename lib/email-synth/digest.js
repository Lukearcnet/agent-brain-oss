/**
 * Digest — Daily email digest generation
 *
 * Aggregates the previous day's classified emails into a summary.
 * Tracks pending responses and sends a morning briefing via ntfy.
 */

/**
 * Generate a daily digest from yesterday's emails.
 * @param {object} db - Supabase client (db.supabase)
 * @param {string} targetDate - ISO date string (YYYY-MM-DD) to digest, defaults to yesterday
 * @returns {object} Digest object ready for storage and notification
 */
async function generateDigest(db, targetDate) {
  // Default to yesterday
  if (!targetDate) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    targetDate = yesterday.toISOString().split("T")[0];
  }

  const startOfDay = `${targetDate}T00:00:00.000Z`;
  const endOfDay = `${targetDate}T23:59:59.999Z`;

  // Fetch all emails from the target date
  const { data: emails, error } = await db
    .from("emails")
    .select("id, from_address, from_name, subject, classification, summary, responded, received_at")
    .gte("received_at", startOfDay)
    .lte("received_at", endOfDay)
    .order("received_at", { ascending: true });

  if (error) {
    console.error("[digest] Failed to fetch emails:", error.message);
    return null;
  }

  const allEmails = emails || [];

  // Compute stats
  const stats = {
    total: allEmails.length,
    respond_now: allEmails.filter(e => e.classification === "RESPOND_NOW").length,
    respond_today: allEmails.filter(e => e.classification === "RESPOND_TODAY").length,
    fyi: allEmails.filter(e => e.classification === "FYI_NO_ACTION").length,
    ignore: allEmails.filter(e => e.classification === "IGNORE").length,
    unclassified: allEmails.filter(e => !e.classification).length
  };

  // Find emails still needing a response (RESPOND_NOW or RESPOND_TODAY, not responded)
  const pendingResponses = allEmails
    .filter(e =>
      (e.classification === "RESPOND_NOW" || e.classification === "RESPOND_TODAY") &&
      !e.responded
    )
    .map(e => ({
      id: e.id,
      from_name: e.from_name,
      from_address: e.from_address,
      subject: e.subject,
      classification: e.classification,
      summary: e.summary,
      received_at: e.received_at
    }));

  // Build readable digest content
  const dateStr = new Date(targetDate).toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric"
  });

  let content = `# Email Digest \u2014 ${dateStr}\n\n`;
  content += `**Total**: ${stats.total} emails\n`;
  content += `- \u{1F534} Respond Now: ${stats.respond_now}\n`;
  content += `- \u{1F7E1} Respond Today: ${stats.respond_today}\n`;
  content += `- \u{1F7E2} FYI/No Action: ${stats.fyi}\n`;
  content += `- \u26AB Ignore: ${stats.ignore}\n`;
  if (stats.unclassified > 0) {
    content += `- \u2753 Unclassified: ${stats.unclassified}\n`;
  }

  if (pendingResponses.length > 0) {
    content += `\n## Pending Responses (${pendingResponses.length})\n\n`;
    for (const p of pendingResponses) {
      const name = p.from_name || p.from_address;
      const icon = p.classification === "RESPOND_NOW" ? "\u{1F534}" : "\u{1F7E1}";
      content += `${icon} **${name}** \u2014 ${p.subject || "(no subject)"}\n`;
      if (p.summary) content += `   ${p.summary}\n`;
      content += "\n";
    }
  }

  return {
    digest_date: targetDate,
    content,
    stats,
    pending_responses: pendingResponses
  };
}

/**
 * Store a digest in Supabase.
 */
async function saveDigest(db, digest) {
  const { error } = await db
    .from("email_digests")
    .upsert({
      id: `digest-${digest.digest_date}`,
      digest_date: digest.digest_date,
      content: digest.content,
      stats: digest.stats,
      pending_responses: digest.pending_responses,
      created_at: new Date().toISOString()
    });

  if (error) {
    console.error("[digest] Failed to save digest:", error.message);
  }
  return !error;
}

/**
 * Get a stored digest by date.
 */
async function getDigest(db, date) {
  const { data, error } = await db
    .from("email_digests")
    .select("*")
    .eq("digest_date", date)
    .single();

  if (error || !data) return null;
  return data;
}

module.exports = { generateDigest, saveDigest, getDigest };
