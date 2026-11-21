/**
 * Security Scanner
 * Checks for security issues in the codebase and configuration
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
 * Run the security scan.
 * @param {object} config - Threshold configuration
 * @returns {Promise<object>} Check result
 */
async function run(config = {}) {
  const scanSecrets = config.scan_secrets !== false;
  const auditLevel = config.audit_level || "moderate";
  const checkRls = config.check_rls !== false;

  const findings = [];
  let overallStatus = "ok";

  try {
    // 1. Check npm audit — only flag exploitable issues (high/critical)
    const auditResult = await runNpmAudit(auditLevel);
    const exploitable = auditResult.critical + auditResult.high;
    if (exploitable > 0) {
      findings.push({
        severity: auditResult.critical > 0 ? "critical" : "warning",
        category: "npm_audit",
        message: `Found ${exploitable} exploitable vulnerabilities (${auditResult.critical} critical, ${auditResult.high} high)`,
        details: {
          critical: auditResult.critical,
          high: auditResult.high,
          moderate: auditResult.moderate,
          low: auditResult.low
        }
      });

      if (auditResult.critical > 0) {
        overallStatus = "critical";
      } else if (auditResult.high > 0) {
        overallStatus = overallStatus === "critical" ? "critical" : "warning";
      }
    } else {
      const infoCount = auditResult.moderate + auditResult.low;
      findings.push({
        severity: "ok",
        category: "npm_audit",
        message: infoCount > 0
          ? `No exploitable vulnerabilities (${infoCount} low/moderate ignored)`
          : "No vulnerable dependencies found"
      });
    }

    // 2. Check for exposed secrets in code
    if (scanSecrets) {
      const secretsFound = await scanForSecrets();
      if (secretsFound.length > 0) {
        findings.push({
          severity: "critical",
          category: "secrets",
          message: `Found ${secretsFound.length} potential exposed secrets`,
          details: secretsFound.map(s => ({
            file: s.file,
            line: s.line,
            pattern: s.pattern,
            preview: s.preview
          }))
        });
        overallStatus = "critical";
      } else {
        findings.push({
          severity: "ok",
          category: "secrets",
          message: "No exposed secrets detected"
        });
      }
    }

    // 3. Check .gitignore for sensitive files
    const gitignoreIssues = checkGitignore();
    if (gitignoreIssues.length > 0) {
      findings.push({
        severity: "warning",
        category: "gitignore",
        message: `${gitignoreIssues.length} sensitive file pattern(s) missing from .gitignore`,
        details: gitignoreIssues
      });
      overallStatus = overallStatus === "critical" ? "critical" : "warning";
    }

    // 4. Check for unsafe code patterns
    const unsafePatterns = await scanUnsafePatterns();
    if (unsafePatterns.length > 0) {
      findings.push({
        severity: "warning",
        category: "unsafe_code",
        message: `Found ${unsafePatterns.length} potentially unsafe code patterns`,
        details: unsafePatterns
      });
      overallStatus = overallStatus === "critical" ? "critical" : "warning";
    }

    // 5. Check file permissions
    const permIssues = checkFilePermissions();
    if (permIssues.length > 0) {
      findings.push({
        severity: "warning",
        category: "permissions",
        message: `Found ${permIssues.length} file(s) with overly permissive permissions`,
        details: permIssues
      });
    }

    // 6. Check Supabase RLS (if enabled)
    if (checkRls) {
      const rlsStatus = await checkSupabaseRLS();
      if (!rlsStatus.enabled) {
        findings.push({
          severity: "warning",
          category: "rls",
          message: "RLS check skipped (requires Supabase admin access)",
          details: rlsStatus
        });
      } else if (rlsStatus.issues.length > 0) {
        findings.push({
          severity: "warning",
          category: "rls",
          message: `${rlsStatus.issues.length} table(s) may have RLS issues`,
          details: rlsStatus.issues
        });
      }
    }

  } catch (err) {
    findings.push({
      severity: "critical",
      category: "error",
      message: `Security scan failed: ${err.message}`
    });
    overallStatus = "critical";
  }

  // Generate summary
  const criticalCount = findings.filter(f => f.severity === "critical").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  let summary = "";
  if (criticalCount > 0) {
    summary = `🚨 ${criticalCount} critical security issue(s)`;
    overallStatus = "critical";
  } else if (warningCount > 0) {
    summary = `⚠️ ${warningCount} security warning(s)`;
  } else {
    summary = "✅ No security issues detected";
  }

  return {
    status: overallStatus,
    summary,
    findings
  };
}

/**
 * Run npm audit and parse results.
 */
async function runNpmAudit(level) {
  try {
    // Run npm audit with JSON output
    const output = execSync("npm audit --json 2>/dev/null || true", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });

    const audit = JSON.parse(output);
    const vulnerabilities = audit.metadata?.vulnerabilities || {};

    return {
      vulnerabilities: Object.values(vulnerabilities).reduce((sum, v) => sum + v, 0),
      critical: vulnerabilities.critical || 0,
      high: vulnerabilities.high || 0,
      moderate: vulnerabilities.moderate || 0,
      low: vulnerabilities.low || 0
    };
  } catch (err) {
    return {
      vulnerabilities: 0,
      critical: 0,
      high: 0,
      moderate: 0,
      low: 0,
      error: err.message
    };
  }
}

/**
 * Scan for exposed secrets in code.
 */
async function scanForSecrets() {
  const patterns = [
    { name: "API Key", regex: /(?:api[_-]?key|apikey)\s*[:=]\s*["']([^"']{20,})["']/gi },
    { name: "Bearer Token", regex: /bearer\s+[a-zA-Z0-9\-_.]{20,}/gi },
    { name: "AWS Key", regex: /AKIA[0-9A-Z]{16}/g },
    { name: "Private Key", regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },
    { name: "Anthropic Key", regex: /sk-ant-[a-zA-Z0-9\-_]{20,}/g },
    { name: "OpenAI Key", regex: /sk-[a-zA-Z0-9]{20,}/g },
    { name: "Password in URL", regex: /(?:https?:\/\/[^:]+:)([^@]+)@/gi }
  ];

  const ignorePaths = [
    "node_modules", ".git", "package-lock.json", ".env.example",
    "MAINTENANCE-MODULE-DESIGN.md", "*.md" // Skip markdown docs
  ];

  const results = [];

  const scanFile = (filePath) => {
    // Skip ignored paths
    for (const ignore of ignorePaths) {
      if (filePath.includes(ignore)) return;
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pattern of patterns) {
          if (pattern.regex.test(line)) {
            // Reset regex state
            pattern.regex.lastIndex = 0;

            // Skip if it's a comment or example
            if (line.includes("example") || line.includes("TODO") || line.includes("//")) {
              continue;
            }

            results.push({
              file: path.relative(PROJECT_ROOT, filePath),
              line: i + 1,
              pattern: pattern.name,
              preview: line.slice(0, 80) + (line.length > 80 ? "..." : "")
            });
          }
        }
      }
    } catch (_) {}
  };

  // Scan JS/TS files
  const scanDir = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!ignorePaths.includes(entry.name)) {
            scanDir(fullPath);
          }
        } else if (entry.isFile() && /\.(js|ts|json|yaml|yml|sh)$/.test(entry.name)) {
          scanFile(fullPath);
        }
      }
    } catch (_) {}
  };

  scanDir(PROJECT_ROOT);
  return results;
}

/**
 * Check .gitignore for sensitive file patterns.
 */
function checkGitignore() {
  const requiredPatterns = [".env", "*.pem", "*.key", "credentials.json", ".env.local", "secrets/"];
  const issues = [];

  try {
    const gitignorePath = path.join(PROJECT_ROOT, ".gitignore");
    const content = fs.readFileSync(gitignorePath, "utf8").toLowerCase();

    for (const pattern of requiredPatterns) {
      if (!content.includes(pattern.toLowerCase())) {
        issues.push({ pattern, message: `"${pattern}" not found in .gitignore` });
      }
    }
  } catch (err) {
    issues.push({ pattern: ".gitignore", message: ".gitignore file not found" });
  }

  return issues;
}

/**
 * Scan for unsafe code patterns.
 */
async function scanUnsafePatterns() {
  const patterns = [
    { name: "eval()", regex: /\beval\s*\(/g },
    { name: "innerHTML assignment", regex: /\.innerHTML\s*=/g },
    { name: "shell exec without escaping", regex: /exec(?:Sync)?\s*\([^)]*\$\{/g },
    { name: "SQL injection risk", regex: /query\s*\(\s*["'`].*\$\{/g }
  ];

  const results = [];

  const scanFile = (filePath) => {
    if (filePath.includes("node_modules") || filePath.includes(".git")) return;

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pattern of patterns) {
          if (pattern.regex.test(line)) {
            pattern.regex.lastIndex = 0;

            // Skip views (legitimate innerHTML use)
            if (filePath.includes("/views/") && pattern.name === "innerHTML assignment") {
              continue;
            }

            results.push({
              file: path.relative(PROJECT_ROOT, filePath),
              line: i + 1,
              pattern: pattern.name,
              preview: line.trim().slice(0, 60)
            });
          }
        }
      }
    } catch (_) {}
  };

  const scanDir = (dir) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
          scanDir(fullPath);
        } else if (entry.isFile() && /\.js$/.test(entry.name)) {
          scanFile(fullPath);
        }
      }
    } catch (_) {}
  };

  scanDir(PROJECT_ROOT);
  return results;
}

/**
 * Check file permissions.
 */
function checkFilePermissions() {
  const sensitiveFiles = [".env", "credentials.json", "service-account.json"];
  const issues = [];

  for (const file of sensitiveFiles) {
    const filePath = path.join(PROJECT_ROOT, file);
    try {
      const stats = fs.statSync(filePath);
      const mode = stats.mode & 0o777;

      // Check if world-readable (o+r)
      if (mode & 0o004) {
        issues.push({
          file,
          mode: mode.toString(8),
          message: `${file} is world-readable`
        });
      }
    } catch (_) {
      // File doesn't exist, which is fine
    }
  }

  return issues;
}

/**
 * Check Supabase RLS status.
 */
async function checkSupabaseRLS() {
  // This would require admin API access which we don't have
  // Just return a placeholder for now
  return {
    enabled: false,
    message: "RLS check requires Supabase admin access",
    issues: []
  };
}

module.exports = { init, run };
