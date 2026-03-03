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
 * Clone or pull a repo. Returns the local path.
 */
async function ensureRepo(repoUrl, projectName) {
  const repoDir = path.join(REPOS_DIR, projectName.toLowerCase().replace(/\s+/g, "-"));

  if (fs.existsSync(path.join(repoDir, ".git"))) {
    // Already cloned — fetch latest
    console.log(`[git] Fetching latest for ${projectName}...`);
    await exec("git", ["fetch", "--all"], { cwd: repoDir });
    return repoDir;
  }

  // Fresh clone
  console.log(`[git] Cloning ${repoUrl} into ${repoDir}...`);
  fs.mkdirSync(repoDir, { recursive: true });
  await exec("git", ["clone", repoUrl, repoDir]);
  return repoDir;
}

/**
 * Create and checkout a new branch for this task.
 */
async function createTaskBranch(repoDir, taskId, defaultBranch = "main") {
  const branchName = `orchestrator/task-${taskId}`;

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

module.exports = { ensureRepo, createTaskBranch, commitAndPush, REPOS_DIR };
