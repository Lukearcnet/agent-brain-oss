/**
 * Code Cleanup Reporter
 * Identifies stale branches, unused code, and cleanup opportunities
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

let db = null;
const PROJECT_ROOT = path.join(__dirname, "../..");

function init(deps) {
  db = deps.db;
}

/**
 * Run the code cleanup analysis.
 * @param {object} config - Threshold configuration
 * @returns {Promise<object>} Check result
 */
async function run(config = {}) {
  const staleBranchDays = config.stale_branch_days || 7;
  const archiveSessionDays = config.archive_session_days || 30;
  const scanUnusedDeps = config.scan_unused_deps !== false;

  const findings = [];
  let overallStatus = "ok";

  try {
    // 1. Find stale git branches
    const staleBranches = await findStaleBranches(staleBranchDays);
    if (staleBranches.length > 0) {
      findings.push({
        severity: "info",
        category: "branches",
        message: `${staleBranches.length} branch(es) with no activity in ${staleBranchDays}+ days`,
        details: staleBranches,
        action: {
          type: "cleanup_branches",
          command: `git branch -d ${staleBranches.map(b => b.name).join(" ")}`
        }
      });
    } else {
      findings.push({
        severity: "ok",
        category: "branches",
        message: "All branches are active"
      });
    }

    // 2. Find unused dependencies
    if (scanUnusedDeps) {
      const unusedDeps = await findUnusedDependencies();
      if (unusedDeps.length > 0) {
        findings.push({
          severity: "info",
          category: "dependencies",
          message: `${unusedDeps.length} potentially unused dependenc(ies)`,
          details: unusedDeps,
          action: {
            type: "remove_deps",
            command: `npm uninstall ${unusedDeps.join(" ")}`
          }
        });
      }
    }

    // 3. Find stale TODO/FIXME comments
    const staleTodos = await findStaleTodos(14);
    if (staleTodos.length > 0) {
      findings.push({
        severity: "info",
        category: "todos",
        message: `${staleTodos.length} TODO/FIXME comment(s) older than 14 days`,
        details: staleTodos.slice(0, 20) // Limit output
      });
    }

    // 4. Find archived sessions that can be deleted
    const archivableSessions = await findArchivableSessions(archiveSessionDays);
    if (archivableSessions.length > 0) {
      findings.push({
        severity: "info",
        category: "sessions",
        message: `${archivableSessions.length} archived session(s) older than ${archiveSessionDays} days`,
        details: archivableSessions.slice(0, 20),
        action: {
          type: "delete_sessions",
          session_ids: archivableSessions.map(s => s.session_id)
        }
      });
    }

    // 5. Find large files that might need attention
    const largeFiles = findLargeFiles();
    if (largeFiles.length > 0) {
      findings.push({
        severity: "info",
        category: "large_files",
        message: `${largeFiles.length} file(s) larger than 100KB`,
        details: largeFiles
      });
    }

    // 6. Find duplicate/similar code patterns
    const duplicates = await findDuplicatePatterns();
    if (duplicates.length > 0) {
      findings.push({
        severity: "info",
        category: "duplicates",
        message: `${duplicates.length} potential code duplication(s) detected`,
        details: duplicates
      });
    }

  } catch (err) {
    findings.push({
      severity: "warning",
      category: "error",
      message: `Code cleanup analysis partially failed: ${err.message}`
    });
    overallStatus = "warning";
  }

  // Generate summary
  const actionableItems = findings.filter(f => f.action);
  let summary = "";

  if (actionableItems.length > 0) {
    const totalCleanupItems = actionableItems.reduce((sum, f) =>
      sum + (f.details?.length || 1), 0
    );
    summary = `${totalCleanupItems} cleanup item(s) ready for review`;
  } else {
    summary = "Codebase is clean";
  }

  return {
    status: overallStatus,
    summary,
    findings
  };
}

/**
 * Find git branches with no recent activity.
 */
async function findStaleBranches(days) {
  const stale = [];

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    // Get all local branches with their last commit date
    const output = execSync(
      'git for-each-ref --sort=-committerdate refs/heads/ --format="%(refname:short)|%(committerdate:iso8601)"',
      { cwd: PROJECT_ROOT, encoding: "utf8" }
    );

    const lines = output.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const [name, dateStr] = line.split("|");
      const lastCommit = new Date(dateStr);

      // Skip main/master
      if (name === "main" || name === "master") continue;

      if (lastCommit < cutoff) {
        stale.push({
          name,
          lastCommit: lastCommit.toISOString(),
          daysInactive: Math.floor((Date.now() - lastCommit.getTime()) / (1000 * 60 * 60 * 24))
        });
      }
    }
  } catch (_) {}

  return stale;
}

/**
 * Find potentially unused npm dependencies.
 */
async function findUnusedDependencies() {
  const unused = [];

  try {
    // Read package.json
    const pkgPath = path.join(PROJECT_ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const deps = Object.keys(pkg.dependencies || {});

    // Read all JS files and check for requires/imports
    const allCode = [];
    const scanDir = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          allCode.push(fs.readFileSync(fullPath, "utf8"));
        }
      }
    };
    scanDir(PROJECT_ROOT);

    const combinedCode = allCode.join("\n");

    for (const dep of deps) {
      // Check if the dependency is used
      const patterns = [
        `require("${dep}")`,
        `require('${dep}')`,
        `from "${dep}"`,
        `from '${dep}'`,
        `require("${dep}/`,
        `require('${dep}/`
      ];

      const isUsed = patterns.some(p => combinedCode.includes(p));
      if (!isUsed) {
        unused.push(dep);
      }
    }
  } catch (_) {}

  return unused;
}

/**
 * Find stale TODO/FIXME comments.
 */
async function findStaleTodos(days) {
  const stale = [];

  try {
    // Use git blame to find old TODOs
    const output = execSync(
      'grep -rn "TODO\\|FIXME" --include="*.js" . 2>/dev/null || true',
      { cwd: PROJECT_ROOT, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }
    );

    const lines = output.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.includes("node_modules")) continue;

      const match = line.match(/^\.\/([^:]+):(\d+):(.*)/);
      if (!match) continue;

      const [, file, lineNum, content] = match;

      try {
        // Get blame for this line
        const blameOutput = execSync(
          `git blame -L ${lineNum},${lineNum} --date=iso "${file}" 2>/dev/null`,
          { cwd: PROJECT_ROOT, encoding: "utf8" }
        );

        const dateMatch = blameOutput.match(/(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) {
          const commitDate = new Date(dateMatch[1]);
          const age = Math.floor((Date.now() - commitDate.getTime()) / (1000 * 60 * 60 * 24));

          if (age > days) {
            stale.push({
              file,
              line: parseInt(lineNum),
              content: content.trim().slice(0, 80),
              age_days: age,
              date: commitDate.toISOString().split("T")[0]
            });
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  return stale;
}

/**
 * Find archived sessions that can be deleted.
 */
async function findArchivableSessions(days) {
  const sessions = [];

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const { data } = await db.supabase
      .from("sessions")
      .select("session_id, title, updated_at")
      .eq("archived", true)
      .lt("updated_at", cutoff.toISOString())
      .order("updated_at", { ascending: true })
      .limit(50);

    for (const s of data || []) {
      sessions.push({
        session_id: s.session_id,
        title: s.title,
        age_days: Math.floor((Date.now() - new Date(s.updated_at).getTime()) / (1000 * 60 * 60 * 24))
      });
    }
  } catch (_) {}

  return sessions;
}

/**
 * Find large files that might need attention.
 */
function findLargeFiles() {
  const large = [];
  const threshold = 100 * 1024; // 100KB

  const checkDir = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "public") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          checkDir(fullPath);
        } else if (entry.isFile()) {
          const stats = fs.statSync(fullPath);
          if (stats.size > threshold) {
            large.push({
              file: path.relative(PROJECT_ROOT, fullPath),
              size_kb: Math.round(stats.size / 1024)
            });
          }
        }
      }
    } catch (_) {}
  };

  checkDir(PROJECT_ROOT);
  return large.sort((a, b) => b.size_kb - a.size_kb).slice(0, 10);
}

/**
 * Find potential code duplications.
 */
async function findDuplicatePatterns() {
  const duplicates = [];

  try {
    // Simple check: find very similar function signatures across files
    const functions = new Map(); // signature → [files]

    const scanFile = (filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      const fnPattern = /(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\([^)]*\)/g;

      let match;
      while ((match = fnPattern.exec(content)) !== null) {
        const fnName = match[1];
        if (!functions.has(fnName)) {
          functions.set(fnName, []);
        }
        functions.get(fnName).push(path.relative(PROJECT_ROOT, filePath));
      }
    };

    const scanDir = (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
          scanFile(fullPath);
        }
      }
    };

    scanDir(PROJECT_ROOT);

    // Find functions defined in multiple files
    for (const [fnName, files] of functions) {
      if (files.length > 1 && !["init", "start", "stop", "run", "handle"].includes(fnName)) {
        duplicates.push({
          function: fnName,
          files: [...new Set(files)]
        });
      }
    }
  } catch (_) {}

  return duplicates.slice(0, 10);
}

module.exports = { init, run };
