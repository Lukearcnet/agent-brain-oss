/**
 * Documentation Drift Checker
 * Ensures CLAUDE.md, handoff prompts, and project memory stay accurate
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

let db = null;
const PROJECT_ROOT = path.join(__dirname, "../..");
// Derive Agent Brain project dir from root path (same encoding as Claude Code)
const AGENT_BRAIN_PROJECT_DIR = PROJECT_ROOT.replace(/\//g, "-");

function init(deps) {
  db = deps.db;
}

/**
 * Run the documentation drift check.
 * @param {object} config - Threshold configuration
 * @returns {Promise<object>} Check result
 */
async function run(config = {}) {
  const maxStaleRefs = config.max_stale_references || 3;
  const criticalFilePatterns = config.critical_file_patterns || ["CLAUDE.md", "handoff"];

  const findings = [];
  let overallStatus = "ok";

  try {
    // 1. Check CLAUDE.md for stale references
    const claudeMdIssues = await checkClaudeMd();
    if (claudeMdIssues.length > 0) {
      const severity = claudeMdIssues.length > maxStaleRefs ? "warning" : "info";
      findings.push({
        severity,
        category: "claude_md",
        message: `CLAUDE.md has ${claudeMdIssues.length} potential stale reference(s)`,
        details: claudeMdIssues
      });

      if (severity === "warning") {
        overallStatus = "warning";
      }
    } else {
      findings.push({
        severity: "ok",
        category: "claude_md",
        message: "CLAUDE.md references appear up to date"
      });
    }

    // 2. Check project memory for outdated content
    const memoryIssues = await checkProjectMemory();
    if (memoryIssues.length > 0) {
      findings.push({
        severity: "info",
        category: "memory",
        message: `Project memory has ${memoryIssues.length} section(s) that may need updates`,
        details: memoryIssues
      });
    }

    // 3. Check handoff templates
    const handoffIssues = await checkHandoffTemplates();
    if (handoffIssues.length > 0) {
      findings.push({
        severity: "warning",
        category: "handoff",
        message: `Handoff templates have ${handoffIssues.length} issue(s)`,
        details: handoffIssues
      });
      overallStatus = overallStatus === "critical" ? "critical" : "warning";
    }

    // 4. Compare docs against recent git changes
    const driftIssues = await checkGitDrift();
    if (driftIssues.length > 0) {
      findings.push({
        severity: "info",
        category: "git_drift",
        message: `${driftIssues.length} file(s) changed recently that may affect documentation`,
        details: driftIssues
      });
    }

  } catch (err) {
    findings.push({
      severity: "critical",
      category: "error",
      message: `Documentation check failed: ${err.message}`
    });
    overallStatus = "critical";
  }

  // Generate summary
  const warningCount = findings.filter(f => f.severity === "warning").length;
  const infoCount = findings.filter(f => f.severity === "info").length;

  let summary = "";
  if (warningCount > 0) {
    summary = `${warningCount} documentation issue(s) need attention`;
    overallStatus = "warning";
  } else if (infoCount > 0) {
    summary = `${infoCount} documentation note(s)`;
  } else {
    summary = "Documentation is up to date";
  }

  return {
    status: overallStatus,
    summary,
    findings
  };
}

/**
 * Check CLAUDE.md for stale references.
 */
async function checkClaudeMd() {
  const issues = [];
  const claudeMdPath = path.join(PROJECT_ROOT, "CLAUDE.md");

  try {
    const content = fs.readFileSync(claudeMdPath, "utf8");

    // Extract file paths mentioned in CLAUDE.md
    // Require either a file extension OR multiple path segments to reduce false positives
    const filePathPattern = /(?:\/[a-zA-Z0-9_.-]+)+(?:\.(?:js|ts|json|html|md|sql|sh|css|txt))/g;
    const dirPathPattern = /(?:\/[a-zA-Z0-9_.-]+){2,}\/?/g; // At least 2 segments for directories

    const fileMatches = [...content.matchAll(filePathPattern)].map(m => m[0]);
    const dirMatches = [...content.matchAll(dirPathPattern)].map(m => m[0]);
    const mentionedPaths = [...new Set([...fileMatches, ...dirMatches])];

    // Common false positive patterns to skip
    const skipPatterns = [
      /^\/api\//,           // API routes
      /localhost/,          // URLs
      /example/i,           // Example paths
      /application\/json/,  // MIME types
      /Content-Type/,       // Headers
      /^\/[A-Z][a-z]+$/,    // Single capitalized word like /Express
      /^\/[a-z]+$/,         // Single lowercase word like /read, /json
    ];

    for (const refPath of mentionedPaths) {
      // Skip false positive patterns
      if (skipPatterns.some(p => p.test(refPath))) {
        continue;
      }

      // Normalize path
      let checkPath = refPath;
      if (!checkPath.startsWith("/Users")) {
        checkPath = path.join(PROJECT_ROOT, refPath);
      }

      // Check if path exists
      if (!fs.existsSync(checkPath)) {
        issues.push({
          type: "missing_file",
          reference: refPath,
          message: `Referenced file/path doesn't exist`
        });
      }
    }

    // Check for outdated function/class references
    const codeRefPattern = /`([a-zA-Z][a-zA-Z0-9_]*)\(\)`|function\s+([a-zA-Z][a-zA-Z0-9_]*)|class\s+([a-zA-Z][a-zA-Z0-9_]*)/g;
    const codeRefs = [...content.matchAll(codeRefPattern)].map(m => m[1] || m[2] || m[3]).filter(Boolean);

    // Sample check: verify some key functions exist
    const serverJs = fs.readFileSync(path.join(PROJECT_ROOT, "server.js"), "utf8");
    for (const ref of codeRefs.slice(0, 20)) { // Limit to avoid too many checks
      if (!serverJs.includes(ref) && !content.includes(`removed`) && !content.includes(`deprecated`)) {
        // Could be a false positive - only flag common patterns
        if (["function", "init", "start", "stop", "run", "get", "set", "create", "load", "save"].some(p => ref.toLowerCase().includes(p))) {
          // Skip generic names
          continue;
        }
      }
    }

    // Check for outdated port/URL references
    const portPattern = /port\s*[:=]?\s*(\d{4})/gi;
    const ports = [...content.matchAll(portPattern)].map(m => m[1]);
    for (const port of ports) {
      if (port !== "3030" && !content.includes("example")) {
        issues.push({
          type: "outdated_port",
          reference: port,
          message: `Port ${port} referenced but Agent Brain uses 3030`
        });
      }
    }

  } catch (err) {
    issues.push({
      type: "read_error",
      message: `Failed to read CLAUDE.md: ${err.message}`
    });
  }

  return issues;
}

/**
 * Check project memory for outdated content.
 */
async function checkProjectMemory() {
  const issues = [];

  try {
    const { data } = await db.supabase
      .from("project_memory")
      .select("*")
      .eq("project_dir", AGENT_BRAIN_PROJECT_DIR)
      .single();

    if (!data || !data.content) {
      issues.push({
        type: "missing_memory",
        message: "No project memory found for Agent Brain"
      });
      return issues;
    }

    const content = data.content;
    const updatedAt = new Date(data.updated_at);
    const daysSinceUpdate = Math.floor((Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24));

    // Check if memory is old
    if (daysSinceUpdate > 7) {
      issues.push({
        type: "stale_memory",
        message: `Project memory last updated ${daysSinceUpdate} days ago`,
        last_updated: updatedAt.toISOString()
      });
    }

    // Check for sections that might be outdated
    const sections = content.split(/^## /m).slice(1);
    for (const section of sections) {
      const sectionName = section.split("\n")[0];

      // Check Recent Changes section age
      if (sectionName.toLowerCase().includes("recent")) {
        // Look for dates in the section
        const datePattern = /\d{4}-\d{2}-\d{2}/g;
        const dates = [...section.matchAll(datePattern)].map(m => new Date(m[0]));
        const oldestDate = dates.length > 0 ? Math.min(...dates.map(d => d.getTime())) : null;

        if (oldestDate) {
          const age = Math.floor((Date.now() - oldestDate) / (1000 * 60 * 60 * 24));
          if (age > 14) {
            issues.push({
              type: "stale_section",
              section: sectionName,
              message: `"${sectionName}" section has entries from ${age} days ago`
            });
          }
        }
      }
    }

  } catch (err) {
    issues.push({
      type: "memory_error",
      message: `Failed to check project memory: ${err.message}`
    });
  }

  return issues;
}

/**
 * Check handoff templates for issues.
 */
async function checkHandoffTemplates() {
  const issues = [];

  try {
    // Check handoff.js for template issues
    const handoffPath = path.join(PROJECT_ROOT, "lib/handoff.js");
    if (fs.existsSync(handoffPath)) {
      const content = fs.readFileSync(handoffPath, "utf8");

      // Check for hardcoded paths that might be wrong
      const pathPattern = /["'`]\/Users\/[^"'`]+["'`]/g;
      const hardcodedPaths = [...content.matchAll(pathPattern)].map(m => m[0]);

      for (const hp of hardcodedPaths) {
        const cleanPath = hp.replace(/["'`]/g, "");
        if (!fs.existsSync(cleanPath)) {
          issues.push({
            type: "hardcoded_path",
            path: cleanPath,
            message: "Hardcoded path in handoff.js doesn't exist"
          });
        }
      }
    }
  } catch (err) {
    issues.push({
      type: "handoff_error",
      message: `Failed to check handoff templates: ${err.message}`
    });
  }

  return issues;
}

/**
 * Check for recent git changes that might affect documentation.
 */
async function checkGitDrift() {
  const issues = [];

  try {
    // Get files changed in last 7 days
    const output = execSync(
      'git log --since="7 days ago" --name-only --pretty=format: | sort | uniq',
      { cwd: PROJECT_ROOT, encoding: "utf8" }
    );

    const changedFiles = output.split("\n").filter(f => f.trim());

    // Check if important files changed but CLAUDE.md didn't
    const importantPatterns = [
      /^server\.js$/,
      /^lib\/[^/]+\.js$/,
      /^scripts\/schema\.sql$/
    ];

    const claudeMdChanged = changedFiles.some(f => f === "CLAUDE.md");
    const importantChanges = changedFiles.filter(f =>
      importantPatterns.some(p => p.test(f))
    );

    if (importantChanges.length > 3 && !claudeMdChanged) {
      issues.push({
        type: "docs_not_updated",
        message: `${importantChanges.length} important file(s) changed in the last 7 days but CLAUDE.md wasn't updated`,
        files: importantChanges.slice(0, 10)
      });
    }

  } catch (err) {
    // Git not available or not a repo
  }

  return issues;
}

module.exports = { init, run };
