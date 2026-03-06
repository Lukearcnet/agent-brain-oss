/**
 * Calendar Notifier — Push notifications for upcoming meetings
 *
 * Checks for events starting soon and sends ntfy.sh push notifications.
 * Also handles conflict alerts.
 */

/**
 * Check for upcoming meetings and send push notifications.
 *
 * @param {object} db - Supabase client
 * @param {function} sendPush - sendPushNotification function
 * @param {object} settings - calendar settings
 */
async function checkUpcomingMeetings(db, sendPush, settings = {}) {
  const minutesBefore = settings.notifyMinutesBefore ?? 15;
  if (!settings.notifyEnabled) return;

  const now = new Date();
  const windowEnd = new Date(now.getTime() + minutesBefore * 60000);

  // Find events starting within the notification window that haven't been notified
  const { data: events, error } = await db
    .from("calendar_events")
    .select("*, email_accounts!inner(label, email, calendar_color)")
    .gte("start_time", now.toISOString())
    .lte("start_time", windowEnd.toISOString())
    .eq("notification_sent", false)
    .eq("all_day", false)
    .neq("status", "cancelled");

  if (error) {
    console.error("[calendar] Failed to check upcoming meetings:", error.message);
    return;
  }

  if (!events || events.length === 0) return;

  for (const event of events) {
    await notifyMeeting(event, sendPush);

    // Mark as notified
    await db
      .from("calendar_events")
      .update({ notification_sent: true })
      .eq("id", event.id);
  }
}

/**
 * Send a push notification for an upcoming meeting.
 */
async function notifyMeeting(event, sendPush) {
  const startTime = new Date(event.start_time);
  const now = new Date();
  const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60000);

  const accountLabel = event.email_accounts?.label || "calendar";
  const timeStr = minutesUntil <= 1
    ? "now"
    : `in ${minutesUntil} min`;

  let message = event.title;
  if (event.location) message += ` · ${event.location}`;
  if (event.hangout_link) message += ` · Meet link available`;

  const attendeeCount = (event.attendees || []).length;
  if (attendeeCount > 0) message += ` · ${attendeeCount} attendee${attendeeCount > 1 ? "s" : ""}`;

  await sendPush({
    title: `📅 Meeting ${timeStr}: ${event.title}`,
    message: `${accountLabel} · ${message}`,
    priority: minutesUntil <= 5 ? 5 : 4
  });
}

/**
 * Send a push notification for a scheduling conflict.
 */
async function notifyConflict(conflict, sendPush) {
  const { event1, event2, overlapMinutes } = conflict;
  const time = new Date(event1.start_time).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit"
  });

  await sendPush({
    title: `⚠️ Calendar Conflict at ${time}`,
    message: `"${event1.title}" vs "${event2.title}" — ${overlapMinutes} min overlap`,
    priority: 3
  });
}

module.exports = { checkUpcomingMeetings, notifyMeeting, notifyConflict };
