#!/usr/bin/env node
/**
 * One-time migration: JSON/JSONL files → Supabase tables.
 * Run AFTER creating all tables via schema.sql.
 *
 * Usage:
 *   node scripts/migrate-to-supabase.js
 *
 * Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SESSIONS_DIR = path.join(__dirname, "..", "sessions");
const MEMORY_DIR = path.join(SESSIONS_DIR, "memory");

let migrated = 0;
let errors = 0;

function log(msg) { console.log(`  ${msg}`); }
function ok(msg) { migrated++; console.log(`  ✓ ${msg}`); }
function fail(msg, err) { errors++; console.error(`  ✗ ${msg}: ${err}`); }

async function migrateSettings() {
  console.log("\n── Settings ──");
  const settingsPath = path.join(__dirname, "..", "settings.json");
  if (!fs.existsSync(settingsPath)) { log("No settings.json found, skipping"); return; }
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    await supabase.from("settings").upsert({
      id: 1,
      notifications: settings.notifications || {},
      auto_approval: settings.autoApproval || {},
      updated_at: new Date().toISOString()
    });
    ok("Settings migrated");
  } catch (e) { fail("Settings", e.message); }
}

async function migrateSessions() {
  console.log("\n── Sessions ──");
  if (!fs.existsSync(SESSIONS_DIR)) { log("No sessions dir"); return; }

  const files = fs.readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith(".json") && f !== "folders.json" && f !== "orchestrator.json");

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8"));
      const { error } = await supabase.from("sessions").upsert({
        session_id: data.session_id,
        title: data.title || "",
        provider: data.provider || "claude-code",
        claude_session_id: data.claude_session_id || null,
        cc_project_dir: data.cc_project_dir || null,
        handoff_from: data.handoff_from || null,
        handoff_prompt: data.handoff_prompt || null,
        archived: false,
        created_at: data.created_at || new Date().toISOString(),
        updated_at: data.updated_at || new Date().toISOString()
      });
      if (error) throw new Error(error.message);
      ok(`Session: ${data.session_id} (${data.title || "untitled"})`);
    } catch (e) { fail(`Session ${file}`, e.message); }
  }

  // Check archive
  const archiveDir = path.join(SESSIONS_DIR, "archive");
  if (fs.existsSync(archiveDir)) {
    const archived = fs.readdirSync(archiveDir).filter(f => f.endsWith(".json"));
    for (const file of archived) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(archiveDir, file), "utf8"));
        await supabase.from("sessions").upsert({
          session_id: data.session_id,
          title: data.title || "",
          provider: data.provider || "claude-code",
          claude_session_id: data.claude_session_id || null,
          cc_project_dir: data.cc_project_dir || null,
          archived: true,
          created_at: data.created_at || new Date().toISOString(),
          updated_at: data.updated_at || new Date().toISOString()
        });
        ok(`Archived session: ${data.session_id}`);
      } catch (e) { fail(`Archived ${file}`, e.message); }
    }
  }
}

async function migrateFolders() {
  console.log("\n── Folders ──");
  const foldersPath = path.join(SESSIONS_DIR, "folders.json");
  if (!fs.existsSync(foldersPath)) { log("No folders.json"); return; }
  try {
    const folders = JSON.parse(fs.readFileSync(foldersPath, "utf8"));
    for (const folder of folders) {
      await supabase.from("folders").upsert({ id: folder.id, name: folder.name });
      if (folder.session_ids && folder.session_ids.length > 0) {
        const mappings = folder.session_ids.map(sid => ({
          folder_id: folder.id,
          session_id: sid
        }));
        // Ignore errors for session_ids that don't exist in sessions table
        await supabase.from("folder_sessions").upsert(mappings, { ignoreDuplicates: true });
      }
      ok(`Folder: ${folder.name} (${(folder.session_ids || []).length} sessions)`);
    }
  } catch (e) { fail("Folders", e.message); }
}

async function migrateEvents() {
  console.log("\n── Events ──");
  const eventsPath = path.join(SESSIONS_DIR, "events.jsonl");
  if (!fs.existsSync(eventsPath)) { log("No events.jsonl"); return; }
  try {
    const raw = fs.readFileSync(eventsPath, "utf8").trim();
    if (!raw) { log("Empty events.jsonl"); return; }
    const lines = raw.split("\n").filter(Boolean);
    const events = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        events.push({
          ts: e.ts,
          type: e.type,
          session_id: e.session_id || null,
          data: e.data || {}
        });
      } catch (_) {}
    }

    // Batch insert in chunks of 500
    for (let i = 0; i < events.length; i += 500) {
      const chunk = events.slice(i, i + 500);
      const { error } = await supabase.from("events").insert(chunk);
      if (error) throw new Error(error.message);
    }
    ok(`Events: ${events.length} rows`);
  } catch (e) { fail("Events", e.message); }
}

async function migrateMailbox() {
  console.log("\n── Mailbox ──");
  const mailboxPath = path.join(SESSIONS_DIR, "mailbox.jsonl");
  if (!fs.existsSync(mailboxPath)) { log("No mailbox.jsonl"); return; }
  try {
    const raw = fs.readFileSync(mailboxPath, "utf8").trim();
    if (!raw) { log("Empty mailbox.jsonl"); return; }
    const lines = raw.split("\n").filter(Boolean);
    const msgs = [];
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        msgs.push({
          id: m.id,
          ts: m.ts,
          from_session: m.from_session || null,
          to_session: m.to_session || "broadcast",
          subject: m.subject || "",
          body: m.body || "",
          read: m.read || false
        });
      } catch (_) {}
    }
    if (msgs.length > 0) {
      const { error } = await supabase.from("mailbox").upsert(msgs);
      if (error) throw new Error(error.message);
    }
    ok(`Mailbox: ${msgs.length} messages`);
  } catch (e) { fail("Mailbox", e.message); }
}

async function migrateOrchestrator() {
  console.log("\n── Orchestrator ──");
  const orchPath = path.join(SESSIONS_DIR, "orchestrator.json");
  if (!fs.existsSync(orchPath)) { log("No orchestrator.json"); return; }
  try {
    const orch = JSON.parse(fs.readFileSync(orchPath, "utf8"));

    if (orch.tasks && orch.tasks.length > 0) {
      const tasks = orch.tasks.map(t => ({
        id: t.id,
        project_dir: t.project_dir || null,
        project_name: t.project_name || "General",
        cwd: t.cwd || null,
        description: t.description || "",
        status: t.status || "pending",
        model: t.model || "sonnet",
        output: t.output || "",
        error: t.error || null,
        started_at: t.started_at || null,
        completed_at: t.completed_at || null
      }));
      await supabase.from("orchestrator_tasks").upsert(tasks);
      ok(`Tasks: ${tasks.length}`);
    }

    if (orch.messages && orch.messages.length > 0) {
      const msgs = orch.messages.map(m => ({
        role: m.role,
        content: m.content || "",
        task_id: m.task_id || null,
        project_name: m.project_name || null,
        update_type: m.update_type || null,
        ts: m.ts || new Date().toISOString()
      }));
      // Batch insert
      for (let i = 0; i < msgs.length; i += 500) {
        await supabase.from("orchestrator_messages").insert(msgs.slice(i, i + 500));
      }
      ok(`Messages: ${msgs.length}`);
    }
  } catch (e) { fail("Orchestrator", e.message); }
}

async function migrateMemory() {
  console.log("\n── Memory ──");
  if (!fs.existsSync(MEMORY_DIR)) { log("No memory dir"); return; }

  const projects = fs.readdirSync(MEMORY_DIR).filter(d =>
    fs.statSync(path.join(MEMORY_DIR, d)).isDirectory()
  );

  for (const projectDir of projects) {
    const projPath = path.join(MEMORY_DIR, projectDir);

    // MEMORY.md
    const memPath = path.join(projPath, "MEMORY.md");
    if (fs.existsSync(memPath)) {
      try {
        const content = fs.readFileSync(memPath, "utf8");
        await supabase.from("project_memory").upsert({
          project_dir: projectDir,
          content,
          updated_at: new Date().toISOString()
        });
        ok(`Memory: ${projectDir}/MEMORY.md`);
      } catch (e) { fail(`Memory ${projectDir}`, e.message); }
    }

    // Daily logs
    const dailyFiles = fs.readdirSync(projPath).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
    for (const file of dailyFiles) {
      try {
        const date = file.replace(".md", "");
        const content = fs.readFileSync(path.join(projPath, file), "utf8");
        await supabase.from("daily_logs").upsert({
          project_dir: projectDir,
          log_date: date,
          content,
          updated_at: new Date().toISOString()
        });
        ok(`Daily: ${projectDir}/${file}`);
      } catch (e) { fail(`Daily ${file}`, e.message); }
    }

    // Topics
    const topicsDir = path.join(projPath, "topics");
    if (fs.existsSync(topicsDir)) {
      const topicFiles = fs.readdirSync(topicsDir).filter(f => f.endsWith(".md"));
      for (const file of topicFiles) {
        try {
          const name = file.replace(".md", "");
          const content = fs.readFileSync(path.join(topicsDir, file), "utf8");
          await supabase.from("memory_topics").upsert({
            project_dir: projectDir,
            name,
            content,
            updated_at: new Date().toISOString()
          });
          ok(`Topic: ${projectDir}/topics/${file}`);
        } catch (e) { fail(`Topic ${file}`, e.message); }
      }
    }
  }
}

async function main() {
  console.log("Agent Brain → Supabase Migration");
  console.log("=================================");

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
    process.exit(1);
  }

  await migrateSettings();
  await migrateSessions();
  await migrateFolders();
  await migrateEvents();
  await migrateMailbox();
  await migrateOrchestrator();
  await migrateMemory();

  console.log("\n=================================");
  console.log(`Done. Migrated: ${migrated}, Errors: ${errors}`);
  if (errors > 0) {
    console.log("Review errors above and re-run if needed.");
  }
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
