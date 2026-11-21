/**
 * Git operations for Fly.io agent runner.
 * Handles clone, branch creation, commit, and push.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPOS_DIR = "/repos";

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

/**
 * Inject GitHub token into HTTPS URL for authenticated access.
 * https://github.com/user/repo.git → https://TOKEN@github.com/user/repo.git
 */
function authedUrl(repoUrl) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !repoUrl.startsWith("https://")) return repoUrl;
  return repoUrl.replace("https://", `https://${token}@`);
}

/**
 * Clone or pull a repo. Returns the local path.
 */
async function ensureRepo(repoUrl, projectName) {
  const repoDir = path.join(REPOS_DIR, projectName.toLowerCase().replace(/\s+/g, "-"));

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    // Already cloned — update remote URL in case token changed, then fetch
    console.log(`[git] Fetching latest for ${projectName}...`);
    await exec("git", ["remote", "set-url", "origin", authedUrl(repoUrl)], { cwd: repoDir });
    await exec("git", ["fetch", "--all"], { cwd: repoDir });
    return repoDir;
  }

  // Fresh clone with authenticated URL
  console.log(`[git] Cloning ${projectName}...`);
  fs.mkdirSync(repoDir, { recursive: true });
  await exec("git", ["clone", authedUrl(repoUrl), repoDir]);

  // Set git identity for commits
  await exec("git", ["config", "user.email", "agent-brain@fly.dev"], { cwd: repoDir });
  await exec("git", ["config", "user.name", "Agent Brain Runner"], { cwd: repoDir });

  return repoDir;
}

/**
 * Create and checkout a new branch for this task.
 */
async function createTaskBranch(repoDir, taskId, defaultBranch = "main") {
  // taskId already has "task-" prefix, so just use orchestrator/{taskId}
  const branchName = `orchestrator/${taskId}`;

  // Ensure we're on the default branch and up to date
  await exec("git", ["checkout", defaultBranch], { cwd: repoDir });
  await exec("git", ["pull", "origin", defaultBranch], { cwd: repoDir }).catch(() => {});

  // Create new branch
  await exec("git", ["checkout", "-b", branchName], { cwd: repoDir });
  console.log(`[git] Created branch ${branchName}`);
  return branchName;
}

/**
 * Stage all changes, commit, and push.
 * Returns { branch, commitHash, hasChanges }.
 */
async function commitAndPush(repoDir, branchName, taskId, projectName) {
  // Check if there are any changes
  const status = await exec("git", ["status", "--porcelain"], { cwd: repoDir });
  if (!status) {
    console.log(`[git] No changes to commit for ${projectName}`);
    return { branch: branchName, commitHash: null, hasChanges: false };
  }

  // Stage all
  await exec("git", ["add", "-A"], { cwd: repoDir });

  // Commit
  const message = `orchestrator: ${projectName} task ${taskId}\n\nAutomated changes from Agent Brain orchestrator.`;
  await exec("git", ["commit", "-m", message], { cwd: repoDir });

  // Get commit hash
  const commitHash = await exec("git", ["rev-parse", "HEAD"], { cwd: repoDir });

  // Push
  console.log(`[git] Pushing ${branchName} for ${projectName}...`);
  await exec("git", ["push", "-u", "origin", branchName], { cwd: repoDir });

  console.log(`[git] Pushed ${branchName} (${commitHash.slice(0, 8)})`);
  return { branch: branchName, commitHash, hasChanges: true };
}

/**
 * Get the diff of the current branch vs the default branch.
 * Returns truncated diff suitable for review prompt (~8000 chars max).
 */
async function getDiff(repoDir, defaultBranch = "main") {
  try {
    const diff = await exec("git", ["diff", `${defaultBranch}...HEAD`, "--stat"], { cwd: repoDir });
    const fullDiff = await exec("git", ["diff", `${defaultBranch}...HEAD`], { cwd: repoDir });
    // Truncate to keep prompt size reasonable
    const truncated = fullDiff.length > 8000
      ? fullDiff.slice(0, 8000) + "\n\n... (diff truncated, " + fullDiff.length + " total chars)"
      : fullDiff;
    return { stat: diff, diff: truncated, fullLength: fullDiff.length };
  } catch (e) {
    return { stat: "", diff: "", fullLength: 0, error: e.message };
  }
}

module.exports = { ensureRepo, createTaskBranch, commitAndPush, getDiff, REPOS_DIR };
