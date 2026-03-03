/**
 * Supabase Data Layer for Agent Brain
 *
 * Drop-in async replacements for every file-based CRUD function in server.js.
 * Function signatures match the originals so the migration is mechanical:
 *   loadSettings()  →  await db.loadSettings()
 *   logEvent(...)   →  db.logEvent(...).catch(console.error)
 */

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Settings (cached — called synchronously in many places) ───────────────

const DEFAULT_SETTINGS = {
  autoApproval: { enabled: false, tools: {}, blockedPatterns: [] },
  notifications: {}
};

let _settingsCache = null;

async function loadSettings() {
  if (_settingsCache) return _settingsCache;
  const { data, error } = await supabase
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();
  if (error || !data) return DEFAULT_SETTINGS;
  _settingsCache = {
    autoApproval: data.auto_approval || DEFAULT_SETTINGS.autoApproval,
    notifications: data.notifications || DEFAULT_SETTINGS.notifications
  };
  return _settingsCache;
}

// Synchronous getter for hot paths (returns cached or defaults)
function getCachedSettings() {
  return _settingsCache || DEFAULT_SETTINGS;
}

async function saveSettings(settings) {
  const row = {
    id: 1,
    notifications: settings.notifications || {},
    auto_approval: settings.autoApproval || {},
    updated_at: new Date().toISOString()
  };
  await supabase.from("settings").upsert(row);
  _settingsCache = settings;
}

// Pre-warm the cache at startup
async function initSettingsCache() {
  await loadSettings();
}

// ── Events ────────────────────────────────────────────────────────────────

async function logEvent(type, sessionId, data = {}) {
  const event = {
    ts: new Date().toISOString(),
    type,
    session_id: sessionId || null,
    data
  };
  await supabase.from("events").insert(event);
  return event;
}

async function queryEvents({ since, type, sessionId, limit = 50 } = {}) {
  let query = supabase
    .from("events")
    .select("*")
    .order("ts", { ascending: false })
    .limit(limit);
  if (since) query = query.gte("ts", since);
  if (type) query = query.eq("type", type);
  if (sessionId) query = query.eq("session_id", sessionId);
  const { data, error } = await query;
  if (error) { console.error("[db] queryEvents:", error.message); return []; }
  return data;
}

// ── Sessions ──────────────────────────────────────────────────────────────

async function createSession(sessionId) {
  const session = {
    session_id: sessionId,
    title: "",
    provider: "claude-code",
    claude_session_id: null,
    cc_project_dir: null,
    handoff_from: null,
    handoff_prompt: null,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await supabase.from("sessions").insert(session);
  // Return with messages array for compat with existing code
  return { ...session, messages: [] };
}

async function saveSession(session) {
  const updated_at = new Date().toISOString();
  const row = {
    session_id: session.session_id,
    title: session.title || "",
    provider: session.provider || "claude-code",
    claude_session_id: session.claude_session_id || null,
    cc_project_dir: session.cc_project_dir || null,
    handoff_from: session.handoff_from || null,
    handoff_prompt: session.handoff_prompt || null,
    archived: session.archived || false,
    updated_at
  };
  await supabase.from("sessions").upsert(row);
}

async function loadSession(session_id) {
  const { data, error } = await supabase
    .from("sessions")
    .select("*")
    .eq("session_id", session_id)
    .single();
  if (error || !data) return null;
  // Add messages array for compat
  return { ...data, messages: [] };
}

async function listSessions() {
  const { data, error } = await supabase
    .from("sessions")
    .select("session_id, title, created_at, updated_at, claude_session_id")
    .eq("archived", false)
    .order("updated_at", { ascending: false });
  if (error) { console.error("[db] listSessions:", error.message); return []; }
  return data.map(s => ({
    ...s,
    title: s.title || "(untitled)"
  }));
}

async function archiveSession(session_id) {
  await supabase
    .from("sessions")
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq("session_id", session_id);
}

async function deleteSession(session_id) {
  // Delete from folder_sessions first (FK constraint)
  await supabase.from("folder_sessions").delete().eq("session_id", session_id);
  await supabase.from("sessions").delete().eq("session_id", session_id);
}

// ── Folders ───────────────────────────────────────────────────────────────

async function loadFolders() {
  const { data: folders, error } = await supabase
    .from("folders")
    .select("id, name, created_at")
    .order("created_at");
  if (error) return [];

  // Load session mappings
  const { data: mappings } = await supabase
    .from("folder_sessions")
    .select("folder_id, session_id");

  return folders.map(f => ({
    id: f.id,
    name: f.name,
    session_ids: (mappings || []).filter(m => m.folder_id === f.id).map(m => m.session_id)
  }));
}

async function createFolder(name) {
  const id = "f_" + Date.now();
  await supabase.from("folders").insert({ id, name });
  return loadFolders();
}

async function moveToFolder(sessionId, folderId) {
  // Remove from all folders first
  await supabase.from("folder_sessions").delete().eq("session_id", sessionId);
  // Add to new folder (if folderId is truthy)
  if (folderId) {
    await supabase.from("folder_sessions").insert({ folder_id: folderId, session_id: sessionId });
  }
  return loadFolders();
}

async function deleteFolder(folderId) {
  // ON DELETE CASCADE handles folder_sessions
  await supabase.from("folders").delete().eq("id", folderId);
  return loadFolders();
}

// ── Mailbox ───────────────────────────────────────────────────────────────

let _mailboxCounter = 0;

async function sendMailboxMessage({ from_session, to_session, subject, body }) {
  const msg = {
    id: "msg-" + (++_mailboxCounter) + "-" + Date.now(),
    ts: new Date().toISOString(),
    from_session: from_session || null,
    to_session: to_session || "broadcast",
    subject: subject || "",
    body: body || "",
    read: false
  };
  await supabase.from("mailbox").insert(msg);
  logEvent("mailbox_message", from_session, { to: to_session, subject }).catch(console.error);
  return msg;
}

async function readMailbox(sessionId, { unreadOnly = false, limit = 50 } = {}) {
  let query = supabase
    .from("mailbox")
    .select("*")
    .or(`to_session.eq.${sessionId},to_session.eq.broadcast`)
    .order("ts", { ascending: false })
    .limit(limit);
  if (unreadOnly) query = query.eq("read", false);
  const { data, error } = await query;
  if (error) { console.error("[db] readMailbox:", error.message); return []; }
  return data;
}

async function readAllMailbox({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from("mailbox")
    .select("*")
    .order("ts", { ascending: false })
    .limit(limit);
  if (error) return [];
  return data;
}

async function markMailboxRead(messageId) {
  const { error } = await supabase
    .from("mailbox")
    .update({ read: true })
    .eq("id", messageId);
  return !error;
}

async function getUnreadCount(sessionId) {
  const { count, error } = await supabase
    .from("mailbox")
    .select("*", { count: "exact", head: true })
    .or(`to_session.eq.${sessionId},to_session.eq.broadcast`)
    .eq("read", false);
  if (error) return 0;
  return count || 0;
}

// ── Orchestrator ──────────────────────────────────────────────────────────

async function loadOrchestrator() {
  const [tasksRes, msgsRes] = await Promise.all([
    supabase.from("orchestrator_tasks").select("*").order("created_at"),
    supabase.from("orchestrator_messages").select("*").order("ts")
  ]);
  return {
    tasks: tasksRes.data || [],
    messages: msgsRes.data || []
  };
}

async function addOrchestratorMessage(msg) {
  await supabase.from("orchestrator_messages").insert({
    role: msg.role,
    content: msg.content || "",
    task_id: msg.task_id || null,
    project_name: msg.project_name || null,
    update_type: msg.update_type || null,
    ts: msg.ts || new Date().toISOString()
  });
}

async function upsertOrchestratorTask(task) {
  await supabase.from("orchestrator_tasks").upsert({
    id: task.id,
    project_dir: task.project_dir || null,
    project_name: task.project_name || "General",
    cwd: task.cwd || null,
    description: task.description,
    status: task.status || "pending",
    model: task.model || "sonnet",
    output: task.output || "",
    error: task.error || null,
    git_branch: task.git_branch || null,
    started_at: task.started_at || null,
    completed_at: task.completed_at || null
  });
}

async function clearOrchestrator() {
  await Promise.all([
    supabase.from("orchestrator_messages").delete().neq("id", 0),
    supabase.from("orchestrator_tasks").delete().neq("id", "")
  ]);
}

// Compat shim: accepts the full {messages, tasks} object like the old saveOrchestrator
async function saveOrchestrator(data) {
  if (data.messages && data.tasks) {
    // Bulk replace — only used during migration transition
    await clearOrchestrator();
    if (data.messages.length > 0) {
      const rows = data.messages.map(m => ({
        role: m.role,
        content: m.content || "",
        task_id: m.task_id || null,
        project_name: m.project_name || null,
        update_type: m.update_type || null,
        ts: m.ts || new Date().toISOString()
      }));
      await supabase.from("orchestrator_messages").insert(rows);
    }
    if (data.tasks.length > 0) {
      const rows = data.tasks.map(t => ({
        id: t.id,
        project_dir: t.project_dir || null,
        project_name: t.project_name || "General",
        cwd: t.cwd || null,
        description: t.description || "",
        status: t.status || "pending",
        model: t.model || "sonnet",
        output: t.output || "",
        error: t.error || null,
        git_branch: t.git_branch || null,
        started_at: t.started_at || null,
        completed_at: t.completed_at || null
      }));
      await supabase.from("orchestrator_tasks").insert(rows);
    }
  }
}

// ── Memory ────────────────────────────────────────────────────────────────

async function listProjects() {
  const { data, error } = await supabase
    .from("project_memory")
    .select("project_dir, updated_at");
  if (error) return [];
  return data.map(d => ({ name: d.project_dir, updated_at: d.updated_at }));
}

async function getProjectMemory(projectDir) {
  const { data, error } = await supabase
    .from("project_memory")
    .select("content")
    .eq("project_dir", projectDir)
    .single();
  if (error || !data) return "";
  return data.content;
}

async function setProjectMemory(projectDir, content) {
  await supabase.from("project_memory").upsert({
    project_dir: projectDir,
    content,
    updated_at: new Date().toISOString()
  });
}

async function listDailyLogs(projectDir) {
  const { data, error } = await supabase
    .from("daily_logs")
    .select("log_date")
    .eq("project_dir", projectDir)
    .order("log_date", { ascending: false });
  if (error) return [];
  return data.map(d => ({
    date: d.log_date,
    filename: d.log_date + ".md"
  }));
}

async function getDailyLog(projectDir, date) {
  const { data, error } = await supabase
    .from("daily_logs")
    .select("content")
    .eq("project_dir", projectDir)
    .eq("log_date", date)
    .single();
  if (error || !data) return "";
  return data.content;
}

async function appendDailyLog(projectDir, content) {
  const today = new Date().toISOString().split("T")[0];
  // Try to get existing log for today
  const { data: existing } = await supabase
    .from("daily_logs")
    .select("content")
    .eq("project_dir", projectDir)
    .eq("log_date", today)
    .single();

  const newContent = existing ? existing.content + "\n\n" + content : content;
  await supabase.from("daily_logs").upsert({
    project_dir: projectDir,
    log_date: today,
    content: newContent,
    updated_at: new Date().toISOString()
  });
  return { date: today };
}

async function listTopics(projectDir) {
  const { data, error } = await supabase
    .from("memory_topics")
    .select("name, updated_at")
    .eq("project_dir", projectDir);
  if (error) return [];
  return data.map(d => ({
    name: d.name,
    filename: d.name + ".md"
  }));
}

async function getTopic(projectDir, name) {
  const { data, error } = await supabase
    .from("memory_topics")
    .select("content")
    .eq("project_dir", projectDir)
    .eq("name", name)
    .single();
  if (error || !data) return "";
  return data.content;
}

async function setTopic(projectDir, name, content) {
  await supabase.from("memory_topics").upsert({
    project_dir: projectDir,
    name,
    content,
    updated_at: new Date().toISOString()
  });
}

// ── Permission Requests (for Fly.io Phase 2) ──────────────────────────────

async function createPermissionRequest({ id, taskId, toolName, toolInput, inputSummary }) {
  await supabase.from("permission_requests").insert({
    id,
    task_id: taskId,
    tool_name: toolName,
    tool_input: toolInput,
    input_summary: inputSummary,
    status: "pending"
  });
}

async function resolvePermissionRequest(id, status) {
  await supabase.from("permission_requests").update({
    status,
    decided_at: new Date().toISOString()
  }).eq("id", id);
}

// ── Exports ───────────────────────────────────────────────────────────────

module.exports = {
  supabase,
  initSettingsCache,

  // Settings
  loadSettings,
  getCachedSettings,
  saveSettings,

  // Events
  logEvent,
  queryEvents,

  // Sessions
  createSession,
  saveSession,
  loadSession,
  listSessions,
  archiveSession,
  deleteSession,

  // Folders
  loadFolders,
  createFolder,
  moveToFolder,
  deleteFolder,

  // Mailbox
  sendMailboxMessage,
  readMailbox,
  readAllMailbox,
  markMailboxRead,
  getUnreadCount,

  // Orchestrator
  loadOrchestrator,
  saveOrchestrator,
  addOrchestratorMessage,
  upsertOrchestratorTask,
  clearOrchestrator,

  // Memory
  listProjects,
  getProjectMemory,
  setProjectMemory,
  listDailyLogs,
  getDailyLog,
  appendDailyLog,
  listTopics,
  getTopic,
  setTopic,

  // Permission requests
  createPermissionRequest,
  resolvePermissionRequest
};
