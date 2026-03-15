/**
 * Google Contacts — People API integration via gws CLI
 *
 * Fetches contacts from Google People API using the gws CLI tool.
 * Returns a map of normalized email → { name, source } for merging
 * into the master contacts endpoint.
 *
 * Requires: gws CLI authenticated with contacts.readonly and
 * contacts.other.readonly scopes.
 */

const { execFile } = require("child_process");
const path = require("path");

const GWS_BIN =
  process.env.GWS_BIN ||
  path.join(process.env.HOME || "", ".npm-global", "bin", "gws");

// Cache Google contacts for 1 hour (they change infrequently)
const CACHE_TTL_MS = 60 * 60 * 1000;
let cache = { value: null, expiresAt: 0 };

/**
 * Run a gws CLI command and return parsed JSON output.
 */
function runGws(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(GWS_BIN, args, { timeout: timeoutMs, env: { ...process.env, PATH: `${path.dirname(GWS_BIN)}:${process.env.PATH}` } }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gws failed: ${err.message} — ${stderr || ""}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(new Error(`gws output parse error: ${parseErr.message}`));
      }
    });
  });
}

/**
 * Fetch all "other contacts" (auto-created from email interactions).
 * Paginates through all pages.
 */
async function fetchOtherContacts() {
  const contacts = [];
  let pageToken = null;

  for (let page = 0; page < 10; page++) {
    const params = {
      readMask: "names,emailAddresses",
      pageSize: 1000,
    };
    if (pageToken) params.pageToken = pageToken;

    const result = await runGws([
      "people",
      "otherContacts",
      "list",
      "--params",
      JSON.stringify(params),
    ]);

    if (result.otherContacts) {
      contacts.push(...result.otherContacts);
    }

    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }

  return contacts;
}

/**
 * Fetch saved contacts (connections).
 * Paginates through all pages.
 */
async function fetchConnections() {
  const contacts = [];
  let pageToken = null;

  for (let page = 0; page < 10; page++) {
    const params = {
      resourceName: "people/me",
      personFields: "names,emailAddresses",
      pageSize: 1000,
    };
    if (pageToken) params.pageToken = pageToken;

    const result = await runGws([
      "people",
      "people",
      "connections",
      "list",
      "--params",
      JSON.stringify(params),
    ]);

    if (result.connections) {
      contacts.push(...result.connections);
    }

    pageToken = result.nextPageToken;
    if (!pageToken) break;
  }

  return contacts;
}

/**
 * Parse a People API person resource into { email, name } pairs.
 */
function parsePersonResource(person) {
  const results = [];
  const emails = person.emailAddresses || [];
  const names = person.names || [];
  const displayName =
    (names[0] && names[0].displayName) || "";

  for (const emailEntry of emails) {
    const email = (emailEntry.value || "").trim().toLowerCase();
    if (email && email.includes("@")) {
      results.push({ email, name: displayName });
    }
  }

  return results;
}

/**
 * Fetch all Google contacts and return a Map of email → { name, source }.
 * Uses a 1-hour cache. Fails gracefully if gws is not available.
 */
async function getGoogleContacts() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) {
    return cache.value;
  }

  const contactMap = new Map();

  try {
    const [otherContacts, connections] = await Promise.all([
      fetchOtherContacts().catch(() => []),
      fetchConnections().catch(() => []),
    ]);

    // Process other contacts first, then connections (connections override)
    for (const person of otherContacts) {
      for (const { email, name } of parsePersonResource(person)) {
        if (name) {
          contactMap.set(email, { name, source: "google-other" });
        }
      }
    }

    for (const person of connections) {
      for (const { email, name } of parsePersonResource(person)) {
        if (name) {
          contactMap.set(email, { name, source: "google-saved" });
        }
      }
    }

    console.log(
      `[contacts] Google People API: ${contactMap.size} contacts loaded (${otherContacts.length} other + ${connections.length} saved)`
    );
  } catch (err) {
    console.warn(`[contacts] Google People API unavailable: ${err.message}`);
    // Return empty map on failure — don't break the contacts endpoint
    return new Map();
  }

  cache.value = contactMap;
  cache.expiresAt = now + CACHE_TTL_MS;
  return contactMap;
}

/**
 * Invalidate the Google contacts cache.
 */
function invalidateCache() {
  cache = { value: null, expiresAt: 0 };
}

module.exports = { getGoogleContacts, invalidateCache };
