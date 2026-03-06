/**
 * Auth Broker — Mac-side token fulfillment service
 *
 * Listens for auth_requests via Supabase Realtime.
 * When a Fly.io agent needs a token:
 *   1. Check cached token in auth_services
 *   2. If expired or missing → run refresh_command on Mac
 *   3. If auto_approve → fulfill immediately
 *   4. If not auto_approve → send push notification, wait for phone approval
 *   5. Write encrypted token to auth_requests row
 *   6. Fly.io picks it up via Realtime
 *
 * Encryption: AES-256-GCM with AUTH_ENCRYPTION_KEY env var
 */

const crypto = require("crypto");
const { execFile } = require("child_process");

// ── Encryption ──────────────────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";
const ENC_KEY = process.env.AUTH_ENCRYPTION_KEY;

function getEncKey() {
  if (!ENC_KEY) throw new Error("AUTH_ENCRYPTION_KEY not set — auth broker disabled");
  // Accept hex (64 chars) or base64 (44 chars) or raw (32 bytes)
  if (ENC_KEY.length === 64) return Buffer.from(ENC_KEY, "hex");
  if (ENC_KEY.length === 44) return Buffer.from(ENC_KEY, "base64");
  return Buffer.from(ENC_KEY.padEnd(32, "\0").slice(0, 32));
}

function encrypt(plaintext) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all base64)
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

function decrypt(encryptedStr) {
  const key = getEncKey();
  const [ivB64, tagB64, dataB64] = encryptedStr.split(":");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

// ── Shell execution ─────────────────────────────────────────────────────────

function runCommand(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile("/bin/bash", ["-c", command], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Command failed: ${stderr || err.message}`));
      resolve(stdout.trim());
    });
  });
}

// ── Push notifications ──────────────────────────────────────────────────────

async function sendPush({ title, message, priority }) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return;
  const server = process.env.NTFY_SERVER || "https://ntfy.sh";
  try {
    await fetch(`${server}/${topic}`, {
      method: "POST",
      headers: { Title: title, Priority: String(priority || 3), Tags: "key" },
      body: message || ""
    });
  } catch (e) {
    console.warn("[auth-broker] Push failed:", e.message);
  }
}

// ── Remote Command Allowlist ────────────────────────────────────────────────
// Commands must match one of these prefixes to execute automatically.
// Anything else is DENIED, logged, and a push notification is sent so the
// user can investigate. To allow a new command pattern, add its prefix here.

const ALLOWED_COMMAND_PREFIXES = [
  // Auth token refresh (keychain, gcloud)
  "security find-generic-password",
  "gcloud auth print-access-token",
  "gcloud auth application-default print-access-token",
  // Handoff / session management (osascript for Terminal/iTerm)
  "osascript -e",
  // Supabase CLI
  "npx supabase ",
  "supabase ",
  // Safe read-only commands
  "which ",
  "echo ",
  "cat ",
  "ls ",
  "pwd",
  "whoami",
  "date",
  "hostname",
];

function isCommandAllowed(command) {
  const trimmed = command.trim();
  return ALLOWED_COMMAND_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

// ── Auth Broker class ───────────────────────────────────────────────────────

class AuthBroker {
  constructor(supabase) {
    this.supabase = supabase;
    this.channel = null;
    this.remoteCommandChannel = null;
    this.running = false;
  }

  /**
   * Start listening for auth requests and remote commands via Realtime.
   */
  start() {
    if (!ENC_KEY) {
      console.warn("[auth-broker] AUTH_ENCRYPTION_KEY not set — auth broker disabled");
      return;
    }

    this.running = true;
    console.log("[auth-broker] Starting auth broker...");

    // Auth requests subscription
    this.channel = this.supabase
      .channel("auth-requests")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "auth_requests",
          filter: "status=eq.pending"
        },
        (payload) => {
          this.handleRequest(payload.new).catch((err) => {
            console.error("[auth-broker] Error handling request:", err.message);
          });
        }
      )
      .subscribe((status) => {
        console.log(`[auth-broker] Auth Realtime: ${status}`);
      });

    // Remote commands subscription
    this.remoteCommandChannel = this.supabase
      .channel("remote-commands")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "remote_commands",
          filter: "status=eq.pending"
        },
        (payload) => {
          this.handleRemoteCommand(payload.new).catch((err) => {
            console.error("[auth-broker] Error handling remote command:", err.message);
          });
        }
      )
      .subscribe((status) => {
        console.log(`[auth-broker] Remote Commands Realtime: ${status}`);
      });

    // Poll for any pending requests/commands missed during downtime
    this.pollPending();
    this.pollPendingCommands();
  }

  /**
   * Stop the auth broker.
   */
  stop() {
    this.running = false;
    if (this.channel) {
      this.supabase.removeChannel(this.channel);
      this.channel = null;
    }
    if (this.remoteCommandChannel) {
      this.supabase.removeChannel(this.remoteCommandChannel);
      this.remoteCommandChannel = null;
    }
    console.log("[auth-broker] Stopped");
  }

  /**
   * Poll for any pending auth requests (catch-up after restart).
   */
  async pollPending() {
    const { data, error } = await this.supabase
      .from("auth_requests")
      .select("*")
      .eq("status", "pending");

    if (error) {
      console.warn("[auth-broker] Poll error:", error.message);
      return;
    }

    if (data && data.length > 0) {
      console.log(`[auth-broker] Found ${data.length} pending requests from before restart`);
      for (const req of data) {
        await this.handleRequest(req).catch((err) => {
          console.error(`[auth-broker] Error fulfilling ${req.id}:`, err.message);
        });
      }
    }
  }

  /**
   * Poll for any pending remote commands (catch-up after restart).
   */
  async pollPendingCommands() {
    const { data, error } = await this.supabase
      .from("remote_commands")
      .select("*")
      .eq("status", "pending");

    if (error) {
      console.warn("[auth-broker] Remote command poll error:", error.message);
      return;
    }

    if (data && data.length > 0) {
      console.log(`[auth-broker] Found ${data.length} pending remote commands from before restart`);
      for (const cmd of data) {
        await this.handleRemoteCommand(cmd).catch((err) => {
          console.error(`[auth-broker] Error executing ${cmd.id}:`, err.message);
        });
      }
    }
  }

  /**
   * Handle a single remote command request.
   * Checks the command against the allowlist before executing.
   * Blocked commands are denied and trigger a push notification.
   */
  async handleRemoteCommand(request) {
    const { id, command, task_id, timeout_ms = 30000 } = request;
    console.log(`[auth-broker] Remote command ${id}: "${command.slice(0, 80)}..." for task ${task_id || "(none)"}`);

    // ── Allowlist check ──
    if (!isCommandAllowed(command)) {
      const msg = `BLOCKED remote command from task ${task_id || "(unknown)"}: "${command.slice(0, 120)}"`;
      console.error(`[auth-broker] ${msg}`);

      // Deny the command
      await this.supabase
        .from("remote_commands")
        .update({
          status: "denied",
          error: "Command not in allowlist. Add its prefix to ALLOWED_COMMAND_PREFIXES in lib/auth-broker.js if this is intentional.",
          completed_at: new Date().toISOString()
        })
        .eq("id", id);

      // Alert the user via push notification
      sendPush({
        title: "Blocked Command",
        message: `An agent tried to run an unrecognized command on your Mac:\n\n${command.slice(0, 200)}\n\nTask: ${task_id || "unknown"}. Command was denied. If this is legit, add the prefix to the allowlist.`,
        priority: 5
      });

      return;
    }

    // Mark as running
    await this.supabase
      .from("remote_commands")
      .update({ status: "running", started_at: new Date().toISOString() })
      .eq("id", id);

    try {
      // Execute the command on Mac
      const output = await runCommand(command, timeout_ms);

      // Encrypt the output
      const outputEncrypted = encrypt(output);

      // Mark as completed with encrypted output
      await this.supabase
        .from("remote_commands")
        .update({
          status: "completed",
          output_encrypted: outputEncrypted,
          completed_at: new Date().toISOString()
        })
        .eq("id", id);

      console.log(`[auth-broker] Remote command ${id}: completed (${output.length} chars output)`);
    } catch (err) {
      console.error(`[auth-broker] Remote command ${id}: failed - ${err.message}`);

      // Mark as failed with error message
      await this.supabase
        .from("remote_commands")
        .update({
          status: "failed",
          error: err.message,
          completed_at: new Date().toISOString()
        })
        .eq("id", id);
    }
  }

  /**
   * Handle a single auth request.
   */
  async handleRequest(request) {
    const { id, service, task_id } = request;
    console.log(`[auth-broker] Request ${id}: ${service} for task ${task_id}`);

    // Get the service config
    const { data: svc, error: svcErr } = await this.supabase
      .from("auth_services")
      .select("*")
      .eq("service", service)
      .single();

    if (svcErr || !svc) {
      console.error(`[auth-broker] Unknown service: ${service}`);
      await this.denyRequest(id, `Unknown auth service: ${service}`);
      return;
    }

    // Check if we have a valid cached token
    if (svc.token_encrypted && svc.expires_at) {
      const expiresAt = new Date(svc.expires_at);
      if (expiresAt > new Date()) {
        // Token is still valid — fulfill immediately
        console.log(`[auth-broker] ${service}: using cached token (expires ${expiresAt.toISOString()})`);
        await this.fulfillRequest(id, svc.token_encrypted);
        return;
      }
    }

    // Token expired or doesn't exist — need to refresh
    if (svc.auto_approve) {
      // Auto-approve: refresh immediately
      await this.refreshAndFulfill(id, svc);
    } else {
      // Need phone approval
      console.log(`[auth-broker] ${service}: waiting for phone approval`);
      sendPush({
        title: `Auth: ${svc.display_name}`,
        message: `Task ${task_id} needs ${svc.display_name} token. Tap to approve.`,
        priority: 4
      });

      // Update request status to "awaiting_approval"
      await this.supabase
        .from("auth_requests")
        .update({ status: "awaiting_approval" })
        .eq("id", id);

      // The phone UI will call the approve endpoint, which triggers refreshAndFulfill
    }
  }

  /**
   * Refresh a service token and fulfill the request.
   */
  async refreshAndFulfill(requestId, service) {
    const refreshCommand = service.refresh_command;

    if (!refreshCommand) {
      // Static token — check if stored in metadata or env
      const staticToken = service.metadata?.static_token || service.token_encrypted;
      if (staticToken) {
        // Re-encrypt if it's a plaintext static token in metadata
        const encrypted = service.metadata?.static_token
          ? encrypt(service.metadata.static_token)
          : staticToken;
        await this.fulfillRequest(requestId, encrypted);
        return;
      }
      await this.denyRequest(requestId, `No refresh command and no cached token for ${service.service}`);
      return;
    }

    try {
      console.log(`[auth-broker] ${service.service}: running refresh command...`);
      const token = await runCommand(refreshCommand);

      if (!token) {
        throw new Error("Refresh command returned empty output");
      }

      // Encrypt and cache the token
      const encrypted = encrypt(token);
      const now = new Date().toISOString();

      // Calculate expiry based on service metadata
      const ttlMs = service.metadata?.ttl_seconds
        ? service.metadata.ttl_seconds * 1000
        : 3600000; // default 1 hour
      const expiresAt = new Date(Date.now() + ttlMs).toISOString();

      // Update the service's cached token
      await this.supabase
        .from("auth_services")
        .update({
          token_encrypted: encrypted,
          expires_at: expiresAt,
          last_refreshed_at: now
        })
        .eq("service", service.service);

      // Fulfill the request
      await this.fulfillRequest(requestId, encrypted);

      console.log(`[auth-broker] ${service.service}: token refreshed, expires ${expiresAt}`);
    } catch (err) {
      console.error(`[auth-broker] ${service.service}: refresh failed:`, err.message);
      await this.denyRequest(requestId, `Token refresh failed: ${err.message}`);
    }
  }

  /**
   * Fulfill an auth request with an encrypted token.
   */
  async fulfillRequest(requestId, tokenEncrypted) {
    await this.supabase
      .from("auth_requests")
      .update({
        status: "fulfilled",
        token_encrypted: tokenEncrypted,
        fulfilled_at: new Date().toISOString()
      })
      .eq("id", requestId);

    console.log(`[auth-broker] Request ${requestId}: fulfilled`);
  }

  /**
   * Deny an auth request.
   */
  async denyRequest(requestId, reason) {
    await this.supabase
      .from("auth_requests")
      .update({
        status: "denied",
        decided_at: new Date().toISOString()
      })
      .eq("id", requestId);

    console.log(`[auth-broker] Request ${requestId}: denied — ${reason}`);
  }

  /**
   * Approve a pending request (called from phone UI).
   */
  async approveRequest(requestId) {
    const { data: req } = await this.supabase
      .from("auth_requests")
      .select("*, auth_services(*)")
      .eq("id", requestId)
      .single();

    if (!req) throw new Error("Request not found");
    if (req.status !== "pending" && req.status !== "awaiting_approval") {
      throw new Error(`Request already ${req.status}`);
    }

    // Get the service config
    const { data: svc } = await this.supabase
      .from("auth_services")
      .select("*")
      .eq("service", req.service)
      .single();

    if (!svc) throw new Error(`Service ${req.service} not found`);

    await this.supabase
      .from("auth_requests")
      .update({ status: "approved", decided_at: new Date().toISOString() })
      .eq("id", requestId);

    // Now refresh and fulfill
    await this.refreshAndFulfill(requestId, svc);
  }

  /**
   * List all registered services with their status.
   */
  async listServices() {
    const { data, error } = await this.supabase
      .from("auth_services")
      .select("*")
      .order("service");

    if (error) throw error;

    return (data || []).map((svc) => ({
      service: svc.service,
      display_name: svc.display_name,
      auto_approve: svc.auto_approve,
      has_token: !!svc.token_encrypted,
      expires_at: svc.expires_at,
      last_refreshed_at: svc.last_refreshed_at,
      refresh_command: svc.refresh_command ? "configured" : null,
      metadata: svc.metadata
    }));
  }

  /**
   * Register or update an auth service.
   */
  async upsertService(serviceConfig) {
    const { service, display_name, refresh_command, auto_approve, metadata } = serviceConfig;

    const { error } = await this.supabase
      .from("auth_services")
      .upsert({
        service,
        display_name,
        refresh_command: refresh_command || null,
        auto_approve: auto_approve !== false,
        metadata: metadata || {}
      });

    if (error) throw error;
    console.log(`[auth-broker] Service ${service} upserted`);
  }

  /**
   * Remove an auth service.
   */
  async removeService(serviceName) {
    const { error } = await this.supabase
      .from("auth_services")
      .delete()
      .eq("service", serviceName);

    if (error) throw error;
    console.log(`[auth-broker] Service ${serviceName} removed`);
  }

  /**
   * Manually refresh a service's token.
   */
  async refreshService(serviceName) {
    const { data: svc, error } = await this.supabase
      .from("auth_services")
      .select("*")
      .eq("service", serviceName)
      .single();

    if (error || !svc) throw new Error(`Service ${serviceName} not found`);

    if (!svc.refresh_command) {
      return { status: "no_refresh_command", service: serviceName };
    }

    const token = await runCommand(svc.refresh_command);
    const encrypted = encrypt(token);
    const ttlMs = svc.metadata?.ttl_seconds ? svc.metadata.ttl_seconds * 1000 : 3600000;

    await this.supabase
      .from("auth_services")
      .update({
        token_encrypted: encrypted,
        expires_at: new Date(Date.now() + ttlMs).toISOString(),
        last_refreshed_at: new Date().toISOString()
      })
      .eq("service", serviceName);

    return { status: "refreshed", service: serviceName, expires_at: new Date(Date.now() + ttlMs).toISOString() };
  }
}

module.exports = { AuthBroker, encrypt, decrypt, ALLOWED_COMMAND_PREFIXES };
