// Run: node --test lib/network-guard.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { checkRequest, buildAllowedHosts, hostnameOf, localTailscaleAddrs } = require("./network-guard");

const ts = new Set(["100.101.102.103", "fd7a:115c:a1e0::1234"]);
const allowed = buildAllowedHosts({ agentBrainUrl: "https://my-mac.tail0000.ts.net", extra: "", tsAddrs: ts });
const chk = (o) => checkRequest(o, allowed, ts);

test("hostnameOf", () => {
  assert.equal(hostnameOf("localhost:3030"), "localhost");
  assert.equal(hostnameOf("[::1]:3030"), "[::1]");
  assert.equal(hostnameOf("My-Mac.tail0000.ts.net."), "my-mac.tail0000.ts.net");
  assert.equal(hostnameOf(""), "");
});

test("legit paths pass", () => {
  // hooks / MCP / curl templates / self-calls
  assert.equal(chk({ localAddress: "127.0.0.1", host: "localhost:3030" }), null);
  assert.equal(chk({ localAddress: "::ffff:127.0.0.1", host: "127.0.0.1:3030" }), null);
  assert.equal(chk({ localAddress: "::1", host: "[::1]:3030" }), null);
  // phone + Mac via tailscale serve (arrives on loopback with the ts.net Host)
  assert.equal(chk({ localAddress: "127.0.0.1", host: "my-mac.tail0000.ts.net", origin: "https://my-mac.tail0000.ts.net" }), null);
  // Chrome tab on the raw Tailscale IP, incl. its own POSTs
  assert.equal(chk({ localAddress: "::ffff:100.101.102.103", host: "100.101.102.103:3030", origin: "http://100.101.102.103:3030" }), null);
  // MagicDNS short name
  assert.equal(chk({ localAddress: "100.101.102.103", host: "my-mac:3030" }), null);
  // dashboard POST from localhost origin
  assert.equal(chk({ localAddress: "127.0.0.1", host: "localhost:3030", origin: "http://localhost:3030" }), null);
});

test("LAN arrivals are refused even with a good Host", () => {
  assert.equal(chk({ localAddress: "192.168.1.142", host: "localhost:3030" }), "interface");
  assert.equal(chk({ localAddress: "::ffff:192.168.1.142", host: "192.168.1.142:3030" }), "interface");
  // a CGNAT-range LAN address that is NOT this Mac's Tailscale IP
  assert.equal(chk({ localAddress: "100.100.5.5", host: "localhost:3030" }), "interface");
});

test("DNS rebinding (foreign Host on loopback) is refused", () => {
  assert.equal(chk({ localAddress: "127.0.0.1", host: "attacker.example:3030" }), "host");
  assert.equal(chk({ localAddress: "100.101.102.103", host: "rebind.attacker.example" }), "host");
  assert.equal(chk({ localAddress: "127.0.0.1", host: "" }), "host");
});

test("cross-site browser requests are refused", () => {
  assert.equal(chk({ localAddress: "127.0.0.1", host: "localhost:3030", origin: "https://evil.example" }), "origin");
  assert.equal(chk({ localAddress: "127.0.0.1", host: "localhost:3030", origin: "null" }), "origin");
});

test("extra hosts from env", () => {
  const a = buildAllowedHosts({ agentBrainUrl: null, extra: "brain.example, Other.Host", tsAddrs: new Set() });
  assert.equal(a.has("brain.example"), true);
  assert.equal(a.has("other.host"), true);
});

test("localTailscaleAddrs reads utun-style interfaces", () => {
  const ifaces = {
    lo0: [{ address: "127.0.0.1" }],
    en0: [{ address: "192.168.1.142" }],
    utun4: [{ address: "100.101.102.103" }, { address: "fd7a:115c:a1e0::1234" }]
  };
  const s = localTailscaleAddrs({ ifaces });
  assert.deepEqual([...s].sort(), ["100.101.102.103", "fd7a:115c:a1e0::1234"]);
});
