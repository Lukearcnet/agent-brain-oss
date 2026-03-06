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
  notifications: {},
  emailSynthesizer: {
    enabled: false,
    pollIntervalBusinessHours: 1800000,
    pollIntervalOffHours: 3600000,
    businessHoursStart: 8,
    businessHoursEnd: 18,
    digestTime: "08:00",
    classificationModel: "claude-haiku-4-5-20251001",
    batchSize: 15,
    maxBodyChars: 500,
    sensitiveDomains: [],
    sensitiveSubjectPatterns: [],
    notifyRespondNow: true,
    notifyRespondToday: true,
    notifyDigest: true
  },
  calendar: {
    enabled: false,
    pollIntervalBusinessHours: 900000,    // 15 min
    pollIntervalOffHours: 3600000,        // 60 min
    businessHoursStart: 8,
    businessHoursEnd: 18,
    notifyMinutesBefore: 15,
    notifyEnabled: true,
    syncWindowDays: 14,
    accountColors: {}
  }
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
    notifications: data.notifications || DEFAULT_SETTINGS.notifications,
    emailSynthesizer: data.email_synthesizer || DEFAULT_SETTINGS.emailSynthesizer,
    calendar: data.calendar || DEFAULT_SETTINGS.calendar
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
    email_synthesizer: settings.emailSynthesizer || {},
    calendar: settings.calendar || {},
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

async function listSessions(includeArchived = true) {
  let query = supabase
    .from("sessions")
    .select("session_id, title, created_at, updated_at, claude_session_id, archived")
    .order("updated_at", { ascending: false });

  if (!includeArchived) {
    query = query.eq("archived", false);
  }

  const { data, error } = await query;
  if (error) { console.error("[db] listSessions:", error.message); return []; }
  return data.map(s => ({
    ...s,
    title: s.title || "(untitled)",
    archived: s.archived || false
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

// ── Memory Facts (Phase 6: Structured learnings from tasks) ───────────────

/**
 * Get all active (non-superseded) facts for a project.
 * Optionally filter by category.
 */
async function getProjectFacts(projectDir, { category, minConfidence = 0.3 } = {}) {
  let query = supabase
    .from("memory_facts")
    .select("*")
    .eq("project_dir", projectDir)
    .is("superseded_by", null)
    .gte("confidence", minConfidence)
    .order("category")
    .order("created_at", { ascending: false });

  if (category) {
    query = query.eq("category", category);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[db] getProjectFacts:", error.message);
    return [];
  }
  return data;
}

/**
 * Add new facts to a project.
 * Performs fuzzy deduplication: if a very similar fact exists, bump its confidence instead.
 */
async function addProjectFacts(projectDir, facts, sourceTaskId = null) {
  const added = [];
  const confirmed = [];

  for (const fact of facts) {
    if (!fact.category || !fact.fact) continue;

    // Check for existing similar fact (simple substring match for now)
    const { data: existing } = await supabase
      .from("memory_facts")
      .select("id, fact, confidence")
      .eq("project_dir", projectDir)
      .eq("category", fact.category)
      .is("superseded_by", null)
      .ilike("fact", `%${fact.fact.slice(0, 50)}%`);

    if (existing && existing.length > 0) {
      // Bump confidence on existing fact
      const match = existing[0];
      const newConfidence = Math.min(1.0, match.confidence + 0.1);
      await supabase.from("memory_facts").update({
        confidence: newConfidence,
        last_confirmed_at: new Date().toISOString()
      }).eq("id", match.id);
      confirmed.push({ id: match.id, fact: match.fact });
    } else {
      // Insert new fact
      const { data, error } = await supabase.from("memory_facts").insert({
        project_dir: projectDir,
        category: fact.category,
        fact: fact.fact,
        source_task_id: sourceTaskId,
        confidence: fact.confidence || 1.0,
        last_confirmed_at: new Date().toISOString()
      }).select("id").single();

      if (!error && data) {
        added.push({ id: data.id, ...fact });
      }
    }
  }

  return { added, confirmed };
}

/**
 * Confirm a fact (bump last_confirmed_at).
 */
async function confirmFact(factId) {
  await supabase.from("memory_facts").update({
    last_confirmed_at: new Date().toISOString()
  }).eq("id", factId);
}

/**
 * Mark a fact as superseded by another fact.
 */
async function supersedeFact(factId, newFactId) {
  await supabase.from("memory_facts").update({
    superseded_by: newFactId
  }).eq("id", factId);
}

/**
 * Decay confidence of old unconfirmed facts.
 * Call periodically (e.g., daily) to deprioritize stale facts.
 */
async function decayOldFacts(projectDir, daysOld = 30, decayAmount = 0.1) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);

  // Get old facts that haven't been confirmed recently
  const { data: oldFacts } = await supabase
    .from("memory_facts")
    .select("id, confidence")
    .eq("project_dir", projectDir)
    .is("superseded_by", null)
    .lt("last_confirmed_at", cutoff.toISOString());

  if (!oldFacts || oldFacts.length === 0) return 0;

  let decayed = 0;
  for (const fact of oldFacts) {
    const newConfidence = Math.max(0, fact.confidence - decayAmount);
    await supabase.from("memory_facts").update({
      confidence: newConfidence
    }).eq("id", fact.id);
    decayed++;
  }

  return decayed;
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

// ── User Tasks ────────────────────────────────────────────────────────────

async function listUserTasks() {
  const { data, error } = await supabase
    .from("user_tasks")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) { console.error("[db] listUserTasks:", error.message); return []; }
  return data;
}

async function createUserTask({ content, project, parentId, sortOrder }) {
  const id = "task-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const { data, error } = await supabase
    .from("user_tasks")
    .insert({
      id,
      content,
      project: project || null,
      parent_id: parentId || null,
      sort_order: sortOrder || 0,
      completed: false
    })
    .select()
    .single();
  if (error) { console.error("[db] createUserTask:", error.message); return null; }
  return data;
}

async function updateUserTask(id, updates) {
  const { error } = await supabase
    .from("user_tasks")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) { console.error("[db] updateUserTask:", error.message); return false; }
  return true;
}

async function deleteUserTask(id) {
  const { error } = await supabase
    .from("user_tasks")
    .delete()
    .eq("id", id);
  if (error) { console.error("[db] deleteUserTask:", error.message); return false; }
  return true;
}

async function reorderUserTasks(taskOrders) {
  // taskOrders is an array of { id, sort_order }
  for (const { id, sort_order } of taskOrders) {
    await supabase
      .from("user_tasks")
      .update({ sort_order, updated_at: new Date().toISOString() })
      .eq("id", id);
  }
  return true;
}

// ── File Locks ────────────────────────────────────────────────────────────

const LOCK_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function acquireFileLock({ filePath, projectDir, sessionId, sessionTitle }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const id = "lock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  const { data, error } = await supabase
    .from("file_locks")
    .insert({
      id,
      file_path: filePath,
      project_dir: projectDir,
      session_id: sessionId,
      session_title: sessionTitle || null,
      acquired_at: now.toISOString(),
      last_activity_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      status: "active"
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") return { acquired: false, conflict: true };
    console.error("[db] acquireFileLock:", error.message);
    return { acquired: false, error: error.message };
  }
  return { acquired: true, lock: data };
}

async function renewFileLock(filePath, sessionId) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  const { error } = await supabase
    .from("file_locks")
    .update({
      last_activity_at: now.toISOString(),
      expires_at: expiresAt.toISOString()
    })
    .eq("file_path", filePath)
    .eq("session_id", sessionId)
    .eq("status", "active");
  return !error;
}

async function releaseFileLock(filePath, sessionId) {
  const { error } = await supabase
    .from("file_locks")
    .update({ status: "released" })
    .eq("file_path", filePath)
    .eq("session_id", sessionId)
    .eq("status", "active");
  return !error;
}

async function releaseSessionLocks(sessionId) {
  const { error } = await supabase
    .from("file_locks")
    .update({ status: "released" })
    .eq("session_id", sessionId)
    .eq("status", "active");
  return !error;
}

async function checkFileLock(filePath) {
  const { data, error } = await supabase
    .from("file_locks")
    .select("*")
    .eq("file_path", filePath)
    .eq("status", "active")
    .single();
  if (error || !data) return null;
  return data;
}

async function getActiveLocks({ projectDir, sessionId } = {}) {
  let query = supabase
    .from("file_locks")
    .select("*")
    .eq("status", "active")
    .order("acquired_at", { ascending: false });
  if (projectDir) query = query.eq("project_dir", projectDir);
  if (sessionId) query = query.eq("session_id", sessionId);
  const { data, error } = await query;
  if (error) { console.error("[db] getActiveLocks:", error.message); return []; }
  return data || [];
}

async function expireOldLocks() {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("file_locks")
    .update({ status: "expired" })
    .eq("status", "active")
    .lt("expires_at", now)
    .select("id, file_path, session_id");
  if (error) { console.error("[db] expireOldLocks:", error.message); return []; }
  return data || [];
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

  // Memory facts
  getProjectFacts,
  addProjectFacts,
  confirmFact,
  supersedeFact,
  decayOldFacts,

  // Permission requests
  createPermissionRequest,
  resolvePermissionRequest,

  // User tasks
  listUserTasks,
  createUserTask,
  updateUserTask,
  deleteUserTask,
  reorderUserTasks,

  // File locks
  acquireFileLock,
  renewFileLock,
  releaseFileLock,
  releaseSessionLocks,
  checkFileLock,
  getActiveLocks,
  expireOldLocks
};
