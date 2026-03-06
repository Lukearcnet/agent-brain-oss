/**
 * Privacy — Sensitive email detection
 *
 * Detects financial, medical, and legal emails by sender domain
 * and subject line patterns. Sensitive emails are classified locally
 * (no body sent to the LLM).
 */

const DEFAULT_SENSITIVE_DOMAINS = new Set([
  // Banks
  "chase.com", "bankofamerica.com", "wellsfargo.com", "citi.com", "usbank.com",
  "capitalone.com", "ally.com", "discover.com", "marcus.com",
  // Payment
  "paypal.com", "venmo.com", "squareup.com", "stripe.com", "cash.app",
  // Investment
  "fidelity.com", "vanguard.com", "schwab.com", "etrade.com", "robinhood.com",
  "wealthfront.com", "betterment.com",
  // Medical
  "mychart.com", "epic.com", "kaiser.org", "myuhc.com",
  // Insurance
  "geico.com", "statefarm.com", "progressive.com", "allstate.com",
  // Tax
  "irs.gov", "turbotax.intuit.com", "hrblock.com"
]);

const DEFAULT_SUBJECT_PATTERNS = [
  /\bstatement\b/i,
  /\baccount\s*balance\b/i,
  /\btax\s*(return|document|form)\b/i,
  /\bw-?2\b/i,
  /\b1099\b/i,
  /\bdiagnos(is|tic)\b/i,
  /\bprescription\b/i,
  /\bhipaa\b/i,
  /\bconfidential\b/i,
  /\blegal\s*notice\b/i,
  /\bsubpoena\b/i,
  /\bsocial\s*security\b/i,
  /\bSSN\b/,
  /\brouting\s*number\b/i,
  /\baccount\s*number\b/i
];

/**
 * Extract domain from an email address or "Name <email>" format.
 */
function extractDomain(fromAddress) {
  if (!fromAddress) return "";
  const match = fromAddress.match(/@([^\s>]+)/);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Check if an email is sensitive based on sender domain and subject.
 * @param {object} email - { from_address, subject }
 * @param {object} settings - emailSynthesizer settings (optional overrides)
 * @returns {{ sensitive: boolean, reason: string|null }}
 */
function isSensitive(email, settings = {}) {
  const domain = extractDomain(email.from_address);

  // Check custom + default domains
  const customDomains = settings.sensitiveDomains || [];
  const allDomains = new Set([...DEFAULT_SENSITIVE_DOMAINS, ...customDomains]);

  if (allDomains.has(domain)) {
    return { sensitive: true, reason: `sensitive_domain:${domain}` };
  }

  // Check subject patterns
  const subject = email.subject || "";
  const customPatterns = (settings.sensitiveSubjectPatterns || []).map(p => new RegExp(p, "i"));
  const allPatterns = [...DEFAULT_SUBJECT_PATTERNS, ...customPatterns];

  for (const pattern of allPatterns) {
    if (pattern.test(subject)) {
      return { sensitive: true, reason: `sensitive_subject:${pattern.source}` };
    }
  }

  return { sensitive: false, reason: null };
}

/**
 * Generate a generic summary for sensitive emails (no LLM needed).
 */
function genericSummary(email) {
  const domain = extractDomain(email.from_address);
  const name = email.from_name || domain;

  // Financial
  if (/bank|fidelity|vanguard|schwab|etrade|robinhood|wealthfront|betterment/i.test(domain)) {
    return `Financial notification from ${name}.`;
  }
  if (/paypal|venmo|square|stripe|cash/i.test(domain)) {
    return `Payment notification from ${name}.`;
  }
  // Medical
  if (/mychart|epic|kaiser|uhc/i.test(domain)) {
    return `Medical/health notification from ${name}.`;
  }
  // Tax
  if (/irs\.gov|turbotax|hrblock/i.test(domain)) {
    return `Tax-related notification from ${name}.`;
  }
  // Insurance
  if (/geico|statefarm|progressive|allstate/i.test(domain)) {
    return `Insurance notification from ${name}.`;
  }

  return `Notification from ${name} (sensitive — not analyzed).`;
}

module.exports = { isSensitive, genericSummary, extractDomain };
