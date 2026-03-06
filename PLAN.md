# Agent Brain — Implementation Plan

> Updated 2026-03-02. Covers Phase 3 onward.
> Phase 1 (Supabase migration) and Phase 2 (Fly.io runner) are complete.

---

## Strategic Principles

1. **The execution layer is a commodity. The routing + memory + auth layer is the moat.**
   - Don't couple to one model/SDK. Build clean dispatch interfaces.
   - Invest in memory that compounds. Every task should leave the system smarter.
   - Own the auth and permissions layer. As agents get more autonomous, human oversight is more valuable.

2. **Build for optionality, not just differentiation today.**
   - Abstract runners so Claude, Codex, Ollama, or any future model slots in via config.
   - Integration surface area (GitHub Issues, Linear, Slack) creates stickiness.
   - The phone is the approval mechanism, the Mac is the root of trust, Fly.io is disposable compute.

3. **Self-hosted, hackable, model-agnostic** — the gap no competitor fills.

---

## Phase 3: End-to-End Test (1 day)

**Goal:** Prove the full Fly.io pipeline works before building more on top.

### Steps
1. From the orchestrator dashboard on phone, dispatch a simple task:
   > "Agent Brain - add a comment to the top of server.js with today's date"
2. Verify each link in the chain:
   - [ ] Agent Brain parses the task and maps to Agent Brain project
   - [ ] HTTP dispatch to `agent-brain-runner.fly.dev/tasks/dispatch` succeeds
   - [ ] Fly.io clones `Lukearcnet/agent-brain` from GitHub
   - [ ] SDK runs, progress streams to `orchestrator_messages` in Supabase
   - [ ] Supabase Realtime fires, Agent Brain broadcasts SSE to dashboard
   - [ ] Phone shows live streaming output
   - [ ] If permission needed: push notification → phone tap → Fly.io continues
   - [ ] On completion: Fly.io commits to `orchestrator/task-xyz` branch and pushes
   - [ ] Dashboard shows "completed" with branch name
   - [ ] On Mac: `git fetch && git log origin/orchestrator/task-xyz` shows the commit
3. Fix anything that breaks. This is the foundation.

### Files Touched
- Possibly `fly-agent-runner/server.js` (bug fixes)
- Possibly `server.js` (Realtime subscription fixes)
- `views/orchestrator.html` (if SSE rendering needs fixes)

---

## Phase 4: Abstract Runner Interface (1-2 days)

**Goal:** Clean dispatch contract so future runners (Codex, Ollama, local) are a config change.

### Architecture

```
dispatchTask(task)
      ↓
  RunnerRegistry.getRunner(task.project, task.model)
      ↓
  ┌──────────────────┬────────────────┬──────────────────┐
  │  FlyClaudeRunner  │  LocalRunner   │  (future: Codex) │
  │  (current)        │  (fallback)    │                  │
  └──────────────────┴────────────────┴──────────────────┘
```

### Runner Interface Contract
```js
// Every runner implements this:
{
  name: "fly-claude",
  dispatch(task, prompt, options) → { ok, task_id }
  cancel(task_id) → { ok }
  healthCheck() → { status, active_tasks }
}
```

### Steps
1. Create `lib/runners/` directory
2. Extract current `dispatchTaskToFly()` into `lib/runners/fly-claude.js`
3. Create `lib/runners/registry.js` — maps project/model → runner
4. Create `lib/runners/local.js` — fallback that runs SDK locally (restores old `spawnTask` behavior for when Fly.io is down or for quick tasks)
5. Update `server.js` to use `registry.dispatch(task)` instead of `dispatchTaskToFly(task)`
6. Runner config stored in Supabase `settings.runners`:
   ```json
   {
     "default": "fly-claude",
     "overrides": {
       "Agent Brain": "local",
       "quick-fix": "local"
     }
   }
   ```

### Files
- NEW: `lib/runners/fly-claude.js`
- NEW: `lib/runners/local.js`
- NEW: `lib/runners/registry.js`
- MODIFY: `server.js` (replace direct dispatch with registry)
- MODIFY: `lib/db.js` (settings.runners schema)

---

## Phase 5: Auth Broker (2-3 days)

**Goal:** Centralized, phone-approvable authentication that makes Fly.io agents feel like they're running on your Mac.

### Core Concept
- **Mac = root of trust.** It has your browser sessions, OAuth grants, SSH keys.
- **Fly.io = ephemeral compute.** It gets short-lived tokens on demand.
- **Phone = approval mechanism.** You tap to approve sensitive auth flows.
- **Supabase = token relay.** Mediates between Fly.io requests and Mac fulfillment.

### New Supabase Tables
```sql
-- Registered services and their cached tokens
CREATE TABLE auth_services (
  service TEXT PRIMARY KEY,           -- "gcloud", "github", "vercel", "supabase"
  display_name TEXT NOT NULL,         -- "Google Cloud"
  token_encrypted TEXT,               -- AES-encrypted current token
  expires_at TIMESTAMPTZ,             -- NULL = never expires (API keys)
  refresh_command TEXT,               -- shell command to run on Mac: "gcloud auth print-access-token"
  auto_approve BOOLEAN DEFAULT true,  -- auto-fulfill or require phone tap
  last_refreshed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'         -- extra info (project ID, scopes, etc.)
);

-- Token requests from Fly.io → fulfilled by Mac
CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,                       -- which orchestrator task needs it
  service TEXT NOT NULL REFERENCES auth_services(service),
  status TEXT DEFAULT 'pending',      -- pending → approved → fulfilled / denied / expired
  token_encrypted TEXT,               -- filled once fulfilled
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ
);
```

### Flow
```
Fly.io agent needs gcloud token
  → INSERT into auth_requests { service: "gcloud", task_id: "..." }
  → Agent Brain (Mac) picks up via Realtime subscription
  → Checks auth_services: is cached token valid?
    YES → writes token to auth_requests.token_encrypted, status="fulfilled"
    NO  → checks auto_approve
      YES → runs refresh_command on Mac, caches result, fulfills request
      NO  → sends push notification to phone
        → user taps Approve
        → Mac runs refresh_command, fulfills request
  → Fly.io picks up fulfilled request via Realtime/polling
  → Continues with the token
```

### Service Configurations (Initial)
| Service | refresh_command | auto_approve | expires |
|---------|----------------|-------------|---------|
| gcloud | `gcloud auth print-access-token` | yes | 1 hour |
| github | `gh auth token` | yes | session |
| vercel | `cat ~/.vercel/auth.json \| jq -r '.token'` | yes | session |
| supabase | (static service role key) | yes | never |
| neo4j | (static password) | yes | never |
| asana | (API key from settings) | yes | never |
| airtable | (API key from settings) | yes | never |
| figma | (personal access token) | yes | never |

### Encryption
- Tokens encrypted at rest in Supabase using AES-256-GCM
- Encryption key = `AUTH_ENCRYPTION_KEY` env var on both Mac and Fly.io
- Even if Supabase is compromised, tokens are useless without the key

### Steps
1. Add `auth_services` and `auth_requests` tables to Supabase
2. Enable Realtime on `auth_requests`
3. Create `lib/auth-broker.js` on Agent Brain (Mac side):
   - Subscribes to auth_requests via Realtime
   - Checks token cache, runs refresh commands, fulfills requests
   - Sends push notifications for non-auto-approve services
4. Create `lib/auth-client.js` on Fly.io runner:
   - `getToken(service)` → requests token, waits for fulfillment (same pattern as permission bridge)
5. Update `fly-agent-runner/server.js`:
   - Before starting SDK task, pre-fetch tokens for services the project needs
   - Inject as env vars into the SDK session
6. Add auth management UI to settings page on phone:
   - View registered services, token status, last refresh
   - Add/remove services
   - Toggle auto-approve per service
   - Manual "refresh now" button
7. Seed initial service configs

### Files
- NEW: `lib/auth-broker.js` (Mac-side token fulfillment)
- NEW: `fly-agent-runner/lib/auth-client.js` (Fly.io-side token requester)
- MODIFY: `fly-agent-runner/server.js` (pre-fetch tokens before task)
- MODIFY: `server.js` (start auth broker Realtime subscription at boot)
- MODIFY: `views/settings.html` (auth service management UI)
- MODIFY: `scripts/schema.sql` (new tables)

---

## Phase 6: Structured Memory Write-Back (2-3 days)

**Goal:** After every task, automatically extract and store structured learnings that compound over time.

### Core Concept
Currently, project memory is free-text written manually by Claude sessions via the mailbox. After Phase 6, every orchestrator task automatically appends structured facts to project memory — patterns discovered, commands that work, gotchas encountered, coding conventions, test commands, deployment steps.

### Memory Schema (augments existing project_memory)
```sql
CREATE TABLE memory_facts (
  id BIGSERIAL PRIMARY KEY,
  project_dir TEXT NOT NULL,
  category TEXT NOT NULL,             -- "convention", "gotcha", "command", "pattern", "dependency", "test"
  fact TEXT NOT NULL,                  -- the actual learning
  source_task_id TEXT,                 -- which task discovered this
  confidence FLOAT DEFAULT 1.0,       -- 1.0 = verified, 0.5 = inferred
  created_at TIMESTAMPTZ DEFAULT now(),
  superseded_by BIGINT REFERENCES memory_facts(id)  -- NULL = current, set when a newer fact replaces this one
);
CREATE INDEX idx_facts_project ON memory_facts (project_dir, category, created_at DESC);
```

### How It Works
1. In `composeTaskPrompt()`, append existing memory facts as structured context:
   ```
   ## Known Facts About This Project
   - [convention] Use async/await, not callbacks (confidence: 1.0)
   - [command] Run tests: npm test (confidence: 1.0)
   - [gotcha] The sessions/ dir is gitignored, don't reference it (confidence: 0.8)
   ```
2. At the end of the task prompt, add extraction instruction:
   ```
   Before finishing, report any new learnings about this project by calling:
   curl -X POST http://localhost:3030/api/memory/{project}/facts -H "Content-Type: application/json" \
     -d '{"facts": [{"category": "convention", "fact": "...", "confidence": 1.0}]}'
   ```
   (On Fly.io, this goes directly to Supabase instead of localhost)
3. Dedup: before storing, check if a similar fact already exists (fuzzy match on fact text). If so, bump confidence instead of adding a duplicate.
4. Decay: facts that haven't been confirmed in 30+ days get confidence reduced. If they drop below 0.3, they're excluded from prompts.

### Steps
1. Add `memory_facts` table to Supabase
2. Add `db.getProjectFacts(projectDir)` and `db.addProjectFacts(projectDir, facts)` to `lib/db.js`
3. Update `composeTaskPrompt()` to include relevant facts in the prompt
4. Add fact extraction instruction to task prompt suffix
5. Add `/api/memory/:projectDir/facts` endpoint for agents to write facts
6. Add fact viewer to `views/memory.html` — browse, edit, delete facts per project
7. On Fly.io runner: add direct Supabase fact insertion (no need to go through Agent Brain API)

### Files
- MODIFY: `lib/db.js` (new fact CRUD functions)
- MODIFY: `server.js` (composeTaskPrompt + new API endpoint)
- MODIFY: `fly-agent-runner/server.js` (fact extraction)
- MODIFY: `views/memory.html` (fact browser UI)
- MODIFY: `scripts/schema.sql` (new table)

---

## Phase 7: GitHub Issues Integration (2-3 days)

**Goal:** Label a GitHub Issue with `agent-brain` → webhook fires → agent dispatches → works → opens PR → links back to issue.

### Architecture
```
GitHub Issue labeled "agent-brain"
  → GitHub webhook POST to Agent Brain
  → Parse issue: title, body, labels, repo
  → Map to project via repo URL
  → Compose task from issue body
  → Dispatch to runner
  → On completion: gh pr create linking to issue
  → Comment on issue with PR link and summary
```

### Steps
1. Expose Agent Brain webhook endpoint to internet (Cloudflare Tunnel or ngrok, or route through Fly.io as a proxy)
2. Create `/api/webhooks/github` endpoint:
   - Validates webhook signature (HMAC-SHA256)
   - Handles `issues.labeled` event where label = "agent-brain"
   - Extracts repo, issue title/body, maps to project
   - Dispatches task with issue context in prompt
3. Update `composeTaskPrompt()` to include issue context when source is GitHub:
   ```
   You are working on GitHub Issue #42: "Add loading skeleton to dashboard"
   Issue body: ...
   When done, your changes will be submitted as a PR linked to this issue.
   ```
4. On task completion, use `gh` CLI on Fly.io to:
   - Create PR with issue reference (`closes #42`)
   - Comment on the issue with a summary of what was done
5. Configure GitHub webhooks on each repo:
   - `gh api repos/OWNER/REPO/hooks --method POST ...`
6. Add issue trigger settings to phone dashboard:
   - Which repos have webhooks enabled
   - Which labels trigger dispatch
   - Default model/runner per repo

### Webhook Security
- GitHub signs every webhook payload with HMAC-SHA256 using a shared secret
- Agent Brain validates the signature before processing
- Webhook secret stored in Supabase settings

### Files
- MODIFY: `server.js` (new webhook endpoint + dispatch from issue)
- MODIFY: `fly-agent-runner/server.js` (post-completion: create PR, comment on issue)
- MODIFY: `fly-agent-runner/lib/git-ops.js` (add createPR function using gh CLI)
- MODIFY: `views/settings.html` (webhook management UI)
- MODIFY: `scripts/schema.sql` (webhook secrets storage)

---

## Future Phases (Not Yet Planned in Detail)

### Phase 8: Agent Self-Review
- Before marking a task complete, agent reviews its own diff
- Runs existing tests if they exist
- Iterates on failures before showing to human
- Implemented as prompt engineering in composeTaskPrompt

### Phase 9: Multi-Model Routing
- Runner registry supports OpenAI Codex, local Ollama, etc.
- Model selection based on task type, project, cost preference
- A/B testing: run same task on two models, compare results

### Phase 10: Policy Engine
- Evolve auto-approval into full policy: "agents can modify tests freely, need approval for API changes, blocked from infrastructure"
- Per-project policies, per-service policies
- Audit log of all policy decisions

### Phase 11: Linear/Jira/Slack Integration
- Same pattern as GitHub Issues but for other tools
- Slack: mention @agent-brain in a channel → dispatches task
- Linear: label an issue → dispatches task

---

## Appendix: What We're NOT Building (And Why)

| Feature | Why Skip |
|---------|----------|
| Video recording of agent sessions | Complex, low ROI for personal use |
| Multi-model support (full) | Premature — Claude is best for coding. Abstract the interface now, implement later. |
| Snapshot/fork agent sessions | Infrastructure complexity not worth it yet |
| Discord/Telegram/email input | Web dashboard + GitHub Issues is enough surface area |
| Competing with Cursor/Devin on polish | Wrong game. Compete on integration depth and ownership. |
