/**
 * Google Calendar Client — Calendar API wrapper
 *
 * Creates authenticated Calendar API clients using the same OAuth tokens
 * stored in email_accounts. Handles calendar listing, event syncing
 * (incremental via syncToken), and event parsing.
 */

const { google } = require("googleapis");
const { createOAuth2Client, encrypt, decrypt } = require("../email-synth/gmail-client");

// ── Calendar Client ──────────────────────────────────────────────────────────

/**
 * Create an authenticated Google Calendar API client for an account.
 * Reuses the same OAuth tokens as the Gmail client.
 * @param {object} account - { tokens_encrypted } from email_accounts table
 * @param {function} onTokenRefresh - Callback when tokens are refreshed
 * @returns {{ cal: object, auth: object }}
 */
function createCalendarClient(account, onTokenRefresh) {
  if (!account.tokens_encrypted) {
    throw new Error("No tokens stored for this account");
  }

  const tokens = JSON.parse(decrypt(account.tokens_encrypted));
  const auth = createOAuth2Client();
  auth.setCredentials(tokens);

  auth.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    if (onTokenRefresh) onTokenRefresh(merged);
  });

  const cal = google.calendar({ version: "v3", auth });
  return { cal, auth };
}

/**
 * Check if an account's tokens include calendar scope.
 * Attempts a lightweight Calendar API call to verify access.
 * @returns {boolean} true if calendar access is available
 */
async function checkCalendarAccess(account, onTokenRefresh) {
  try {
    const { cal } = createCalendarClient(account, onTokenRefresh);
    await cal.calendarList.list({ maxResults: 1 });
    return true;
  } catch (err) {
    if (err.code === 403 || err.code === 401) return false;
    throw err;
  }
}

// ── Calendar Operations ──────────────────────────────────────────────────────

/**
 * List all calendars for an account.
 * @returns {Array} [{id, summary, backgroundColor, primary}]
 */
async function listCalendars(cal) {
  const res = await cal.calendarList.list();
  return (res.data.items || []).map(c => ({
    id: c.id,
    summary: c.summary || c.id,
    backgroundColor: c.backgroundColor || "#007aff",
    primary: !!c.primary,
    accessRole: c.accessRole
  }));
}

/**
 * Sync events from a calendar. Uses syncToken for incremental sync when available.
 *
 * @param {object} cal - Google Calendar API client
 * @param {string} calendarId - Calendar ID (e.g. "primary")
 * @param {object} options - { syncToken, syncWindowDays }
 * @returns {{ events: Array, nextSyncToken: string, fullSync: boolean }}
 */
async function syncEvents(cal, calendarId, options = {}) {
  const { syncToken, syncWindowDays = 14 } = options;

  try {
    if (syncToken) {
      // Incremental sync
      const res = await cal.events.list({
        calendarId,
        syncToken,
        singleEvents: true,
        maxResults: 250
      });

      return {
        events: (res.data.items || []).map(parseEvent),
        nextSyncToken: res.data.nextSyncToken,
        fullSync: false
      };
    }
  } catch (err) {
    // 410 Gone = syncToken expired, fall through to full sync
    if (err.code !== 410) throw err;
    console.log(`[calendar] syncToken expired for ${calendarId}, doing full sync`);
  }

  // Full sync — fetch events from now through syncWindowDays ahead
  const timeMin = new Date();
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + syncWindowDays);

  const allEvents = [];
  let pageToken = null;

  do {
    const params = {
      calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,       // Expand recurring events
      orderBy: "startTime",
      maxResults: 250
    };
    if (pageToken) params.pageToken = pageToken;

    const res = await cal.events.list(params);
    allEvents.push(...(res.data.items || []).map(parseEvent));
    pageToken = res.data.nextPageToken;

    // On the last page, capture the sync token
    if (!pageToken) {
      return {
        events: allEvents,
        nextSyncToken: res.data.nextSyncToken,
        fullSync: true
      };
    }
  } while (pageToken);

  return { events: allEvents, nextSyncToken: null, fullSync: true };
}

// ── Event Parsing ────────────────────────────────────────────────────────────

/**
 * Parse a Google Calendar event into a clean object.
 */
function parseEvent(event) {
  const isAllDay = !!event.start?.date;

  let startTime, endTime;
  if (isAllDay) {
    startTime = new Date(event.start.date + "T00:00:00").toISOString();
    endTime = new Date(event.end.date + "T00:00:00").toISOString();
  } else {
    startTime = new Date(event.start.dateTime).toISOString();
    endTime = new Date(event.end.dateTime).toISOString();
  }

  // Extract attendees
  const attendees = (event.attendees || []).map(a => ({
    email: a.email,
    name: a.displayName || a.email,
    responseStatus: a.responseStatus || "needsAction",
    self: !!a.self
  }));

  // Find video call link
  const hangoutLink = event.hangoutLink
    || event.conferenceData?.entryPoints?.find(e => e.entryPointType === "video")?.uri
    || null;

  return {
    google_event_id: event.id,
    title: event.summary || "(No title)",
    description: (event.description || "").slice(0, 500),
    location: event.location || null,
    start_time: startTime,
    end_time: endTime,
    all_day: isAllDay,
    status: event.status || "confirmed",
    organizer: event.organizer?.email || null,
    attendees,
    hangout_link: hangoutLink,
    recurring_event_id: event.recurringEventId || null,
    color_id: event.colorId || null
  };
}

// ── Event Creation ───────────────────────────────────────────────────────────

/**
 * Create a new event on a Google Calendar.
 * @param {object} cal - Google Calendar API client
 * @param {string} calendarId - Calendar ID (usually "primary")
 * @param {object} eventData - { title, description, location, start, end, allDay, attendees }
 * @returns {object} Created event (parsed)
 */
async function createEvent(cal, calendarId, eventData) {
  const resource = {
    summary: eventData.title,
    description: eventData.description || "",
    location: eventData.location || ""
  };

  if (eventData.allDay) {
    resource.start = { date: eventData.start }; // YYYY-MM-DD
    resource.end = { date: eventData.end || eventData.start };
  } else {
    resource.start = { dateTime: new Date(eventData.start).toISOString() };
    resource.end = { dateTime: new Date(eventData.end).toISOString() };
  }

  if (eventData.attendees && eventData.attendees.length > 0) {
    resource.attendees = eventData.attendees.map(email => ({ email }));
  }

  // Add Google Meet if requested
  if (eventData.addMeet) {
    resource.conferenceData = {
      createRequest: { requestId: `meet-${Date.now()}` }
    };
  }

  const res = await cal.events.insert({
    calendarId,
    resource,
    conferenceDataVersion: eventData.addMeet ? 1 : 0,
    sendUpdates: eventData.attendees?.length ? "all" : "none"
  });

  return parseEvent(res.data);
}

// ── Event Update ────────────────────────────────────────────────────────────

/**
 * Update an existing event on Google Calendar.
 * Fetches the existing event first to preserve unmodified fields.
 */
async function updateEvent(cal, calendarId, eventId, eventData) {
  const existing = await cal.events.get({ calendarId, eventId });
  const resource = existing.data;

  if (eventData.title !== undefined) resource.summary = eventData.title;
  if (eventData.description !== undefined) resource.description = eventData.description;
  if (eventData.location !== undefined) resource.location = eventData.location;

  if (eventData.start !== undefined && eventData.end !== undefined) {
    if (eventData.allDay) {
      resource.start = { date: eventData.start };
      resource.end = { date: eventData.end || eventData.start };
    } else {
      resource.start = { dateTime: new Date(eventData.start).toISOString() };
      resource.end = { dateTime: new Date(eventData.end).toISOString() };
    }
  }

  if (eventData.attendees !== undefined) {
    resource.attendees = eventData.attendees.map(e =>
      typeof e === 'string' ? { email: e } : e
    );
  }

  const res = await cal.events.update({
    calendarId,
    eventId,
    resource,
    sendUpdates: resource.attendees?.length ? "all" : "none"
  });

  return parseEvent(res.data);
}

// ── Event Deletion ──────────────────────────────────────────────────────────

/**
 * Delete an event from Google Calendar.
 */
async function deleteEvent(cal, calendarId, eventId) {
  await cal.events.delete({ calendarId, eventId, sendUpdates: "all" });
}

module.exports = {
  createCalendarClient,
  checkCalendarAccess,
  listCalendars,
  syncEvents,
  parseEvent,
  createEvent,
  updateEvent,
  deleteEvent,
  encrypt,
  decrypt
};
