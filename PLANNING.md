# Agent Brain — Development Plan

## Strategic Position

Agent Brain is a **local agent supervision console** for Claude Code power users.

**What we are:** A control tower for monitoring and governing multiple Claude Code sessions from your phone. Attention routing, governance automation, cross-session supervision.

**What we are NOT:** A "remote Claude" client. Anthropic shipped native Remote Control (Feb 25, 2026). Competing on single-session remote access is a losing lane.

**Defensible features (things Anthropic doesn't do):**
- Aggregated supervision across all sessions — "what needs my attention right now?"
- Policy-based auto-approval — customizable governance rules per tool/project
- No opt-in required — reads all local sessions automatically via JSONL
- Works with Claude Desktop's Code mode (not just CLI)
- Cross-session notification aggregation

**Target user:** Founders and indie devs who code with Claude but can't sit at a desk all day.

**Business model:** $20 one-time purchase on Gumroad. Open core (engine free on GitHub, supervision UX paid). Grandfather early buyers if switching to subscription later ($5/mo or $30/year).

---

## Phase 1: Foundation (Week 1)

### 1.1 — Git workflow
- Freeze `main` as production
- All development on feature branches
- Merge to main only when tested

### 1.2 — Extract HTML templates from server.js
- Pull the session list page and chat page HTML into separate template files (e.g., `views/home.html`, `views/chat.html`)
- server.js reads and serves them with template variable substitution
- Cuts server.js nearly in half, makes UI iteration fast without scrolling past backend logic

### 1.3 — fs.watch + WebSocket for real-time updates
- Replace 5-second polling with `fs.watch` on JSONL files
- WebSocket connection from phone to server
- Permission prompts appear instantly, messages sync live
- This is the foundation everything else builds on

### 1.4 — Fix permission bar persistence bug
- **Current bug:** After clicking Allow/Deny on phone, the permission bar sometimes persists or reappears even though the action was processed on desktop
- **Root cause:** The 5-second poll re-checks the JSONL and the stall pattern may still match briefly after approval (the tool_result hasn't been written yet)
- **Fix:** After sending an approve/deny action, suppress the permission bar for that session for ~10 seconds (client-side cooldown), or track the last-approved tool_use ID and skip it on subsequent checks

---

## Phase 2: Core Product (Weeks 2-3)

### 2.1 — Supervision dashboard as home screen
- Replace session list as the default landing page at `/`
- Three sections:
  - **Needs attention** — sessions with pending permission prompts, inline Allow/Deny buttons
  - **Active** — sessions currently running (recent JSONL writes), show what tool is executing
  - **Idle** — sessions with no recent activity
- Each item links to full session chat view
- This is the core product surface — "what needs me right now"

### 2.2 — Policy-based auto-approval
- Settings page accessible from dashboard
- Three tiers:
  - **Auto-approve (green):** Read, Glob, Grep, Bash read-only (ls, git status, cat, etc.)
  - **Require approval (yellow):** Write, Edit, Bash mutating commands, NotebookEdit
  - **Always block (red):** Bash with destructive patterns (rm -rf, git push --force, drop table, etc.)
- Stored in local config file (`settings.json`)
- When a stall is detected, check tool name + input against policy. If auto-approve, immediately send Enter keystroke without surfacing the banner
- Per-project overrides (e.g., auto-approve more in trusted repos)

### 2.3 — Session switching from phone
- **Problem:** Currently messages inject into whatever session is focused in Claude Desktop. No reliable way to programmatically switch sessions (`claude://resume` creates duplicates)
- **Approach:** Inspect Claude Desktop's accessibility tree via AppleScript to identify session rows in the sidebar, match by session title/slug, click to switch, then inject
- **Fallback:** If accessibility tree matching fails, show a warning on the phone: "Make sure [session name] is open in Claude Desktop" rather than injecting into the wrong session
- **Acceptable latency:** 1-2s delay for reliable switching is fine
- Research task: probe Claude Desktop's accessibility tree structure to determine feasibility

### 2.4 — Cross-session notifications
- When any session stalls on a permission prompt, fire a macOS notification:
  `osascript -e 'display notification "Bash: npm test" with title "Agent Brain: agent-brain session"'`
- Apple notification forwarding delivers this to iPhone automatically (same Apple ID)
- Zero infrastructure, ~10 lines of code
- In-app: aggregated notification banner on dashboard (section 2.1 covers this)

---

## Phase 3: Shareable (Week 4)

### 3.1 — Guided setup wizard
- `/setup` route with step-by-step onboarding
- Step 1: Detect Claude Desktop installed → link to install if not
- Step 2: Grant Accessibility permission → open System Settings directly, poll until confirmed
- Step 3: Tailscale setup → detect, show QR code to pair phone
- Step 4: Keep Mac awake → button to run pmset commands (show paste-in-Terminal fallback for sudo)
- Step 5: Test injection → verify full pipeline works end-to-end
- Each step has green checkmark, can't proceed until prior step passes

### 3.2 — Mobile UI polish
- Make it feel native iOS — proper safe area handling, haptic-style feedback, smooth transitions
- Dark mode support
- PWA manifest + service worker for "Add to Home Screen" with app icon
- 30-second demo-worthy appearance

### 3.3 — Distribution setup
- Gumroad listing with $20 price point
- License key validation on first setup (Gumroad API)
- Landing page with 30-second demo video
- Install script: `curl -fsSL https://agentbrain.dev/install.sh | bash`

---

## Known Bugs to Fix

### Permission bar persistence
- **Symptom:** After clicking Allow or Deny on phone, the permission bar disappears briefly but reappears on the next poll cycle, even though the action was processed on desktop
- **Impact:** Low (harmless — new real prompts replace stale ones), but feels buggy
- **Fix:** Client-side cooldown after action, or track last-approved tool_use block ID

---

## Long-Term Features (Future Consideration)

These are NOT in the near-term plan. Listed here so we don't forget them.

### Multi-runtime supervision
- Adapter abstraction: common interface for `getSessions()`, `getMessages()`, `detectStall()`, `sendMessage()`
- Claude Code as Adapter #1
- Potential future adapters: Cursor agent logs, Windsurf, terminal long-running jobs
- Only build when there's a real second runtime to support

### Claude Chat & Cowork support
- Chat and Cowork modes in Claude Desktop are currently server-side (no local JSONL files)
- If Anthropic adds local storage for these modes, extend supervision to cover them
- Dashboard design should leave room for these to slot in without redesign
- Low priority until local file access exists

### Other model support
- ChatGPT, Gemini, etc. would require browser automation (Playwright) as adapter
- Different class of complexity — auth cookies, DOM selectors, rate limits
- Only pursue if there's a real use case where another model gives something Claude doesn't
- Not relevant near-term

### Advanced governance
- Auto-approve rules that learn from behavior ("you always approve Bash in agent-brain repo")
- Audit log of all approvals/denials with timestamps
- Role-based access for teams (junior devs need approval, seniors auto-approve)
- Cost tracking across sessions

### Enhanced UX
- Voice input via iOS speech-to-text
- Screenshot/file sharing from phone into sessions
- Scheduled tasks ("run this prompt at 9am every day")
- Prompt template library
- Session handoff between projects
- Multi-Mac support

### Ecosystem
- Plugin/recipe system for community-built workflows
- Shared configurations
- Community Discord

### Packaging & Distribution
- Node.js SEA (Single Executable Application) — compile to standalone binary
- Homebrew tap
- Possible native macOS menubar app (Swift) if warranted
- PWA push notifications via service worker

---

## Reference

- **Q&A document:** `/Users/lukeblanton/agent-brain/Q&A on Agent Brain Pivot.docx`
- **Product roadmap (earlier research):** `/Users/lukeblanton/agent-brain/PRODUCT_ROADMAP.md`
- **Current codebase:** Single-file `server.js` (~1,750 lines) + `AgentBrainHelper.app`
- **Claude JSONL location:** `~/.claude/projects/<encoded-path>/<session-id>.jsonl`
- **Anthropic Remote Control (shipped Feb 25, 2026):** CLI-only, requires `claude remote-control` or `/rc`, per-session, no aggregated supervision, no auto-approve policies
