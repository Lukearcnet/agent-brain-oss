#!/usr/bin/env node
/**
 * Backfill: file existing unfiled sessions into the folder matching their project.
 *
 * Folders were always hand-curated, so sessions created after the last manual
 * tidy-up sat in "Unfiled" forever even though each carries a correct
 * cc_project_dir. This maps cc_project_dir -> projects.json name -> folder name.
 *
 * Only touches sessions that are in NO folder. Never moves an existing mapping.
 *
 *   node scripts/backfill-session-folders.js            # dry run
 *   node scripts/backfill-session-folders.js --apply    # write
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const db = require("../lib/db");

const APPLY = process.argv.includes("--apply");

(async () => {
  const sessions = await db.listSessions(true);
  const folders = await db.loadFolders();

  const projects = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "projects.json"), "utf8"));
  const dirToName = {};
  for (const v of Object.values(projects)) {
    if (v && typeof v === "object" && v.dir && v.name) dirToName[v.dir] = v.name;
  }

  const filed = new Set();
  for (const f of folders) for (const sid of f.session_ids) filed.add(sid);

  const byName = new Map();
  for (const f of folders) {
    const k = (f.name || "").trim().toLowerCase();
    const prev = byName.get(k);
    // duplicate names exist; prefer the folder that already holds more sessions
    if (!prev || f.session_ids.length > prev.session_ids.length) byName.set(k, f);
  }

  const plan = [];
  const skipped = {};
  for (const s of sessions) {
    if (filed.has(s.session_id)) continue;
    const name = dirToName[s.cc_project_dir];
    if (!name) { skipped[`no project for ${s.cc_project_dir || "<none>"}`] = (skipped[`no project for ${s.cc_project_dir || "<none>"}`] || 0) + 1; continue; }
    const target = byName.get(name.trim().toLowerCase());
    if (!target) { skipped[`no folder named ${name}`] = (skipped[`no folder named ${name}`] || 0) + 1; continue; }
    plan.push({ session_id: s.session_id, title: s.title, folder_id: target.id, folder: target.name });
  }

  const counts = {};
  for (const p of plan) counts[p.folder] = (counts[p.folder] || 0) + 1;
  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${plan.length} sessions to file\n`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  -> ${k}`);
  console.log("\n  skipped (left unfiled, correctly):");
  for (const [k, v] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);

  if (!APPLY) { console.log("\nRe-run with --apply to write."); return; }

  const undo = path.join(__dirname, "..", "logs", `backfill-folders-undo-${Date.now()}.json`);
  fs.writeFileSync(undo, JSON.stringify(plan, null, 2));
  console.log(`\n  undo list written to ${undo}`);

  for (let i = 0; i < plan.length; i += 50) {
    const chunk = plan.slice(i, i + 50).map(p => ({ folder_id: p.folder_id, session_id: p.session_id }));
    const { error } = await db.supabase.from("folder_sessions").insert(chunk);
    if (error) { console.error("  insert failed:", error.message); process.exit(1); }
  }
  console.log(`  filed ${plan.length} sessions.`);
})();
