"use strict";

function compactTitle(text, maxLen = 55) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  return clean.length > maxLen ? clean.slice(0, maxLen - 3) + "..." : clean;
}

function getProjectNameFromPath(projectPath) {
  const clean = String(projectPath || "").trim().replace(/\/+$/, "");
  if (!clean) return "";
  const parts = clean.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : clean;
}

function getTaskLine(text) {
  const match = String(text || "").match(/## Your Task\s+([\s\S]*?)(?:\n## |\n---|\n```|$)/);
  if (!match) return "";
  const firstLine = match[1]
    .split("\n")
    .map(line => line.trim())
    .find(Boolean);
  return compactTitle(firstLine || "", 55);
}

function isGenericHandoffTitle(title) {
  return /^Handoff:\s+/i.test(String(title || "").trim());
}

function formatShortTimestamp(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const suffix = hours >= 12 ? "p" : "a";
  hours = hours % 12 || 12;
  return `${month} ${day} ${hours}:${minutes}${suffix}`;
}

function normalizeSessionTitle({ title, firstUserMessage, projectName, provider } = {}) {
  const rawTitle = String(title || "").trim();
  const rawFirst = String(firstUserMessage || "").trim();
  const fallbackProject = compactTitle(projectName || "", 55);
  const fallbackProvider = provider === "codex" ? "Codex Session" : "Claude Session";
  const source = rawTitle || rawFirst;

  if (!source) {
    return fallbackProject || fallbackProvider;
  }

  if (source.startsWith("# Session Handoff Briefing")) {
    const match = source.match(/\*\*Project\*\*:\s*(.+)/);
    const handoffProject = compactTitle(match ? match[1] : fallbackProject || "Session", 40);
    return `Handoff: ${handoffProject}`;
  }

  if (source.startsWith("# New Codex Session") || source.startsWith("# New Claude Code Session")) {
    const taskLine = getTaskLine(source);
    if (taskLine) return taskLine;
    return fallbackProject || fallbackProvider;
  }

  return compactTitle(source, 55);
}

function getDisplaySessionTitle({ title, firstUserMessage, projectName, provider, createdAt, updatedAt } = {}) {
  const baseTitle = normalizeSessionTitle({ title, firstUserMessage, projectName, provider });
  if (!isGenericHandoffTitle(baseTitle)) {
    return baseTitle;
  }

  const stamp = formatShortTimestamp(createdAt || updatedAt);
  if (!stamp) return baseTitle;
  return compactTitle(`${baseTitle} · ${stamp}`, 72);
}

module.exports = {
  compactTitle,
  formatShortTimestamp,
  getProjectNameFromPath,
  getDisplaySessionTitle,
  isGenericHandoffTitle,
  normalizeSessionTitle
};
