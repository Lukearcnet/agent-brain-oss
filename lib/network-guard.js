// Network guard for the Agent Brain HTTP server (security review 2026-11-13).
//
// Agent Brain binds 0.0.0.0:3030 with auth off. Before this guard:
//   • anyone on the same Wi-Fi/LAN could read memory, email and calendar,
//     answer checkpoints, inject "user" messages and spawn sessions;
//   • any web page the user opened could reach it via DNS rebinding (no Host check)
//     or plain cross-site form/multipart POSTs (no Origin check).
//
// Rules (all must pass):
//   1. Connection arrived on loopback or on this Mac's Tailscale interface
//      (judged by the socket's LOCAL address, which a remote peer cannot fake).
//      Wi-Fi/Ethernet arrivals are refused.
//   2. Host header names this machine: localhost / 127.0.0.1 / [::1], a local
//      Tailscale address, the ts.net name from settings.agentBrainUrl, its
//      short MagicDNS name, or anything in AB_ALLOWED_HOSTS. Blocks rebinding.
//   3. A browser Origin header, when present, must also be one of those hosts.
//      Blocks cross-site POSTs (incl. multipart uploads) from other sites.
//
// `tailscale serve` (https://<name>.ts.net → localhost:3030) arrives on
// loopback with the ts.net Host, so the phone path passes all three.

const os = require("os");

function stripV4Mapped(a) {
  return String(a || "").replace(/^::ffff:/i, "");
}

function isLoopback(addr) {
  const a = stripV4Mapped(addr);
  return a === "::1" || /^127\./.test(a);
}

function isTailscaleAddr(addr) {
  const a = stripV4Mapped(addr).toLowerCase();
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) return Number(m[1]) === 100 && Number(m[2]) >= 64 && Number(m[2]) <= 127; // 100.64.0.0/10
  return a.startsWith("fd7a:115c:a1e0:"); // Tailscale ULA
}

// This Mac's own Tailscale addresses (re-read every 60 s; Tailscale can come up after us).
let _tsCache = { at: 0, addrs: new Set() };
function localTailscaleAddrs({ force = false, ifaces = null, now = Date.now() } = {}) {
  if (!ifaces && !force && now - _tsCache.at < 60000) return _tsCache.addrs;
  const set = new Set();
  for (const list of Object.values(ifaces || os.networkInterfaces())) {
    for (const i of list || []) if (isTailscaleAddr(i.address)) set.add(i.address.toLowerCase());
  }
  if (!ifaces) _tsCache = { at: now, addrs: set };
  return set;
}

function hostnameOf(hostHeader) {
  const h = String(hostHeader || "").trim().toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]:3030 → [::1]
  return h.replace(/:\d+$/, "").replace(/\.$/, "");
}

function buildAllowedHosts({ agentBrainUrl, extra, tsAddrs }) {
  const set = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const a of tsAddrs || []) set.add(a.includes(":") ? `[${a}]` : a);
  if (agentBrainUrl) {
    try {
      const h = new URL(agentBrainUrl).hostname.toLowerCase();
      set.add(h);
      if (h.endsWith(".ts.net")) set.add(h.split(".")[0]); // short MagicDNS name
    } catch { /* ignore bad setting */ }
  }
  for (const h of String(extra || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) set.add(h);
  return set;
}

// → null if allowed, else a short reason string
function checkRequest({ localAddress, host, origin }, allowedHosts, tsAddrs) {
  const local = stripV4Mapped(localAddress).toLowerCase();
  // Only THIS Mac's Tailscale addresses count — not any 100.64/10 address, since
  // some hotel/hotspot LANs use that CGNAT range themselves.
  if (!(isLoopback(local) || tsAddrs.has(local))) return "interface";
  const hn = hostnameOf(host);
  if (!hn || !allowedHosts.has(hn)) return "host";
  if (origin && origin !== "null") {
    let oh = "";
    try { oh = new URL(origin).hostname.toLowerCase(); } catch { return "origin"; }
    if (oh.includes(":") && !oh.startsWith("[")) oh = `[${oh}]`;
    if (!allowedHosts.has(oh)) return "origin";
  } else if (origin === "null") {
    return "origin"; // sandboxed iframes / file: pages
  }
  return null;
}

// Express middleware. getAgentBrainUrl is called per request so a settings change applies live.
function networkGuard({ getAgentBrainUrl = () => null, extraHosts = process.env.AB_ALLOWED_HOSTS, log = console.warn } = {}) {
  let lastLog = 0;
  return (req, res, next) => {
    let tsAddrs = localTailscaleAddrs();
    const local = stripV4Mapped(req.socket.localAddress).toLowerCase();
    if (isTailscaleAddr(local) && !tsAddrs.has(local)) tsAddrs = localTailscaleAddrs({ force: true }); // Tailscale just came up
    const allowed = buildAllowedHosts({ agentBrainUrl: getAgentBrainUrl(), extra: extraHosts, tsAddrs });
    const reason = checkRequest(
      { localAddress: req.socket.localAddress, host: req.headers.host, origin: req.headers.origin },
      allowed,
      tsAddrs
    );
    if (!reason) return next();
    const now = Date.now();
    if (now - lastLog > 5000) {
      lastLog = now;
      log(`[network-guard] refused (${reason}) from ${req.socket.remoteAddress} host=${String(req.headers.host || "").slice(0, 80)} ${req.method} ${req.path}`);
    }
    return res.status(403).type("text/plain").send("Forbidden");
  };
}

module.exports = { networkGuard, checkRequest, buildAllowedHosts, hostnameOf, isTailscaleAddr, isLoopback, localTailscaleAddrs };
