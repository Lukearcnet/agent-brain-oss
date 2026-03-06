/**
 * Auth Client — Fly.io side token requester
 *
 * Requests tokens from the Auth Broker (Mac) via Supabase.
 * Flow:
 *   1. INSERT into auth_requests { service, task_id, status: "pending" }
 *   2. Wait for status to become "fulfilled" (via Realtime + polling)
 *   3. Decrypt the token from auth_requests.token_encrypted
 *   4. Return the plaintext token
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const ENC_KEY = process.env.AUTH_ENCRYPTION_KEY;

function getEncKey() {
  if (!ENC_KEY) throw new Error("AUTH_ENCRYPTION_KEY not set");
  if (ENC_KEY.length === 64) return Buffer.from(ENC_KEY, "hex");
  if (ENC_KEY.length === 44) return Buffer.from(ENC_KEY, "base64");
  return Buffer.from(ENC_KEY.padEnd(32, "\0").slice(0, 32));
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

/**
 * Request a token for a service.
 * Inserts a request into Supabase, waits for the Mac to fulfill it.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} service - Service name (e.g., "gcloud", "github")
 * @param {string} taskId - Task ID requesting the token
 * @param {number} timeoutMs - Max wait time (default 60s)
 * @returns {Promise<string>} - Decrypted token
 */
async function getToken(supabase, service, taskId, timeoutMs = 60000) {
  const requestId = `auth-${taskId}-${service}-${Date.now()}`;

  // Insert the request
  const { error: insertErr } = await supabase.from("auth_requests").insert({
    id: requestId,
    task_id: taskId,
    service,
    status: "pending"
  });

  if (insertErr) {
    throw new Error(`Failed to create auth request: ${insertErr.message}`);
  }

  console.log(`[auth-client] Requesting ${service} token (${requestId})`);

  // Wait for fulfillment via Realtime + polling
  return new Promise((resolve, reject) => {
    let settled = false;
    let channel;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (channel) supabase.removeChannel(channel);
        reject(new Error(`Auth request for ${service} timed out (${timeoutMs / 1000}s)`));
      }
    }, timeoutMs);

    // Subscribe to updates on this specific request
    channel = supabase
      .channel(`auth-${requestId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "auth_requests",
          filter: `id=eq.${requestId}`
        },
        (payload) => {
          const row = payload.new;
          handleResult(row);
        }
      )
      .subscribe();

    // Poll fallback
    const poller = setInterval(async () => {
      if (settled) { clearInterval(poller); return; }
      const { data } = await supabase
        .from("auth_requests")
        .select("*")
        .eq("id", requestId)
        .single();
      if (data) handleResult(data);
    }, 3000);

    function handleResult(row) {
      if (settled) return;

      if (row.status === "fulfilled" && row.token_encrypted) {
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        if (channel) supabase.removeChannel(channel);

        try {
          const token = decrypt(row.token_encrypted);
          console.log(`[auth-client] ${service} token received`);
          resolve(token);
        } catch (err) {
          reject(new Error(`Failed to decrypt ${service} token: ${err.message}`));
        }
      } else if (row.status === "denied") {
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        if (channel) supabase.removeChannel(channel);
        reject(new Error(`Auth request for ${service} was denied`));
      }
    }
  });
}

/**
 * Pre-fetch tokens for services a project needs.
 * Returns a map of service → token.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string[]} services - Service names to fetch
 * @param {string} taskId - Task ID
 * @returns {Promise<Record<string, string>>} - Map of service → token
 */
async function prefetchTokens(supabase, services, taskId) {
  const tokens = {};

  // Fetch all in parallel
  const results = await Promise.allSettled(
    services.map(async (service) => {
      const token = await getToken(supabase, service, taskId);
      return { service, token };
    })
  );

  for (const result of results) {
    if (result.status === "fulfilled") {
      tokens[result.value.service] = result.value.token;
    } else {
      console.warn(`[auth-client] Failed to get token: ${result.reason.message}`);
    }
  }

  return tokens;
}

/**
 * Run a command on the Mac via the remote command broker.
 * Useful for commands that only exist on the Mac (keychain, osascript, etc.)
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} command - Shell command to run on Mac
 * @param {object} opts - Options
 * @param {string} opts.taskId - Task ID requesting the command
 * @param {number} opts.timeoutMs - Max wait time (default 60s)
 * @param {number} opts.commandTimeoutMs - Max command execution time (default 30s)
 * @returns {Promise<string>} - Command output (decrypted)
 */
async function runRemoteCommand(supabase, command, opts = {}) {
  const { taskId = null, timeoutMs = 60000, commandTimeoutMs = 30000 } = opts;
  const requestId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Insert the command request
  const { error: insertErr } = await supabase.from("remote_commands").insert({
    id: requestId,
    task_id: taskId,
    command,
    status: "pending",
    timeout_ms: commandTimeoutMs
  });

  if (insertErr) {
    throw new Error(`Failed to create remote command request: ${insertErr.message}`);
  }

  console.log(`[auth-client] Requesting remote command (${requestId}): "${command.slice(0, 50)}..."`);

  // Wait for completion via Realtime + polling
  return new Promise((resolve, reject) => {
    let settled = false;
    let channel;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (channel) supabase.removeChannel(channel);
        reject(new Error(`Remote command timed out (${timeoutMs / 1000}s)`));
      }
    }, timeoutMs);

    // Subscribe to updates on this specific command
    channel = supabase
      .channel(`cmd-${requestId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "remote_commands",
          filter: `id=eq.${requestId}`
        },
        (payload) => {
          handleResult(payload.new);
        }
      )
      .subscribe();

    // Poll fallback
    const poller = setInterval(async () => {
      if (settled) { clearInterval(poller); return; }
      const { data } = await supabase
        .from("remote_commands")
        .select("*")
        .eq("id", requestId)
        .single();
      if (data) handleResult(data);
    }, 2000);

    function handleResult(row) {
      if (settled) return;

      if (row.status === "completed" && row.output_encrypted) {
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        if (channel) supabase.removeChannel(channel);

        try {
          const output = decrypt(row.output_encrypted);
          console.log(`[auth-client] Remote command completed (${output.length} chars)`);
          resolve(output);
        } catch (err) {
          reject(new Error(`Failed to decrypt command output: ${err.message}`));
        }
      } else if (row.status === "failed") {
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        if (channel) supabase.removeChannel(channel);
        reject(new Error(`Remote command failed: ${row.error || "unknown error"}`));
      } else if (row.status === "denied") {
        settled = true;
        clearTimeout(timer);
        clearInterval(poller);
        if (channel) supabase.removeChannel(channel);
        reject(new Error("Remote command was denied"));
      }
    }
  });
}

module.exports = { getToken, prefetchTokens, runRemoteCommand, decrypt };
