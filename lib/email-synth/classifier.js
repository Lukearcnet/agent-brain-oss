/**
 * Classifier — Claude Haiku email classification + summarization
 *
 * Batches emails and sends to Claude Haiku with a few-shot prompt.
 * Returns classification (RESPOND_NOW, RESPOND_TODAY, FYI_NO_ACTION, IGNORE)
 * and a one-sentence action summary per email.
 */

const SYSTEM_PROMPT = `You are an email triage assistant. Classify each email into exactly one urgency category and provide a one-sentence action summary.

Categories:
- RESPOND_NOW: Needs reply within hours. Direct questions from real people, time-sensitive requests, urgent work matters.
- RESPOND_TODAY: Needs attention today but not immediately. Non-urgent questions, scheduling, follow-ups, assigned tasks.
- FYI_NO_ACTION: Informational only. Confirmations, shipping notifications, newsletters you read, calendar events.
- IGNORE: No value. Marketing, spam, promotional emails, social media notifications, mass newsletters.

Rules:
- The summary MUST state what action is expected from the recipient, and any deadline or time constraint mentioned.
- If the recipient is CC'd (not in To:), lean toward FYI_NO_ACTION unless directly addressed in the body.
- Calendar invites without conflicts = FYI_NO_ACTION.
- Tool notifications (Jira, GitHub, Slack) = RESPOND_TODAY only if directly assigned/mentioned; otherwise FYI_NO_ACTION.
- Automated noreply@ service emails (shipping, receipts, confirmations) = FYI_NO_ACTION.

Return a valid JSON array. Each item must have: email_id, classification, summary.
Example: [{"email_id":"abc123","classification":"RESPOND_NOW","summary":"Boss needs Q3 budget feedback before 2pm today."}]`;

/**
 * Classify a batch of emails using Claude Haiku.
 * @param {object[]} emails - Array of { id, from_address, from_name, to_addresses, cc_addresses, subject, snippet, received_at }
 * @param {object} options - { apiKey, model, maxBodyChars }
 * @returns {object[]} - Array of { email_id, classification, summary }
 */
async function classifyBatch(emails, options = {}) {
  const {
    apiKey = process.env.ANTHROPIC_API_KEY,
    model = "claude-haiku-4-5-20251001",
    maxBodyChars = 500
  } = options;

  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  if (!emails || emails.length === 0) return [];

  // Format emails for the prompt
  const emailsForPrompt = emails.map(e => ({
    email_id: e.id,
    from: e.from_name ? `${e.from_name} <${e.from_address}>` : e.from_address,
    to: (e.to_addresses || []).join(", "),
    cc: (e.cc_addresses || []).length > 0 ? (e.cc_addresses || []).join(", ") : undefined,
    subject: e.subject || "(no subject)",
    date: e.received_at,
    body_preview: (e.snippet || "").slice(0, maxBodyChars)
  }));

  // Remove undefined fields for cleaner JSON
  const cleanEmails = emailsForPrompt.map(e => {
    const clean = {};
    for (const [k, v] of Object.entries(e)) {
      if (v !== undefined) clean[k] = v;
    }
    return clean;
  });

  const userMessage = `Classify these emails:\n\n${JSON.stringify(cleanEmails, null, 2)}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }]
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API error (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const content = data.content?.[0]?.text || "";

  // Parse JSON from response (handle markdown code fences)
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error("[classifier] Failed to parse JSON from response:", content.slice(0, 200));
    return [];
  }

  try {
    const results = JSON.parse(jsonMatch[0]);
    // Validate each result
    return results.filter(r =>
      r.email_id &&
      ["RESPOND_NOW", "RESPOND_TODAY", "FYI_NO_ACTION", "IGNORE"].includes(r.classification)
    ).map(r => ({
      email_id: r.email_id,
      classification: r.classification,
      summary: r.summary || ""
    }));
  } catch (e) {
    console.error("[classifier] JSON parse error:", e.message);
    return [];
  }
}

module.exports = { classifyBatch, SYSTEM_PROMPT };
