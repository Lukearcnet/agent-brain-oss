# Agent Brain — Product Roadmap & Research

## 1. Making It Easily Replicable

**Recommended approach: One-line install script + Node.js Single Executable Application (SEA)**

- **Node.js SEA** (built into Node 20+) lets you compile the server into a single standalone binary — no `npm install`, no Node dependency. User downloads one file and runs it.
- **One-line install** like `curl -fsSL https://agentbrain.dev/install.sh | bash` — downloads the binary, sets up launchd, creates the `.env` template, opens a setup wizard in the browser.
- **Homebrew tap** is also viable (`brew install agentbrain/tap/agent-brain`) but more maintenance.
- **Minimal user input needed:** OpenAI API key, Anthropic API key (optional), and Tailscale must be installed. The install script can detect Tailscale and prompt if missing.
- The setup wizard (localhost web page on first run) walks them through API keys, Accessibility permissions for the helper app, and Tailscale connection.

**Bottom line:** A `curl | bash` install that drops a single binary + launchd plist + helper .app, then opens a browser setup wizard. 5 minutes to running.

---

## 2. Web (Localhost) vs iOS App

**Recommendation: PWA first, native later only if needed.**

- **PWA on iOS Safari (2025+)** now supports: home screen icon, full-screen mode, push notifications (since iOS 16.4), and badge counts. It already *feels* like a native app.
- Your current web UI already works great on mobile Safari — a PWA just adds a manifest.json and service worker for offline/home-screen support.
- **Native iOS app** would cost 3-6 months of Swift development, $99/year Apple Developer account, App Store review (Apple is unpredictable with remote-control tools), and you'd need to maintain two codebases.
- **Hybrid (Capacitor/React Native)** is a middle ground but adds complexity without much benefit over PWA for your use case.
- **The killer argument for PWA:** your server is already serving HTML. Adding PWA support is ~50 lines of code. A native app is a whole new project.

**Bottom line:** Stay web-based, add PWA manifest so users can "Add to Home Screen" and get the native app feel for free.

---

## 3. Subscription & Payments

**Recommended: Stripe for web subscriptions, license key model.**

- **Stripe Checkout** — drop-in subscription flow. User pays on your website, gets a license key emailed. The Agent Brain server validates the key on startup.
- **Pricing model that works for dev tools:** Free tier (single provider, 1 session) → Pro $10-15/mo (multi-provider, unlimited sessions, permission approval, autonomous mode) → Team $25/mo (shared sessions, multiple Macs).
- **License key approach** (like Raycast/Sublime): generate a signed JWT on purchase, the binary validates it locally. No phone-home required. Simple and developer-friendly.
- **RevenueCat** only needed if you go native iOS — overkill for web-only.
- **If you go App Store later:** Apple takes 30%, but handles all billing. Many dev tools avoid this by selling web subscriptions and shipping a free app that activates with the key.

**Bottom line:** Stripe + license keys. Sell on the web, validate locally in the binary. Keep it simple.

---

## 4. UI, Speed, and Capability Improvements

**UI:**
- Add PWA manifest + service worker for home screen install
- Conversation search/filter
- Dark mode
- Haptic feedback on iOS for approve/deny buttons
- Session grouping by project/context
- Notification sound/vibration when permission prompt detected

**Speed:**
- WebSocket instead of 5-second polling — instant updates when messages arrive or permissions are needed
- Stream responses in real-time instead of waiting for full completion
- Cache JSONL reads — only read new bytes since last check (track file offset)

**Capabilities:**
- **Multi-Mac support** — control Claude Desktop on multiple machines
- **Scheduled tasks** — "run this prompt at 9am every day"
- **Prompt templates/library** — save common prompts for quick reuse
- **Session handoff** — start on Claude, continue on GPT, or vice versa
- **Voice input** — use iOS speech-to-text for hands-free injection
- **Notification when task completes** — push notification via PWA when an autonomous task finishes
- **Context sharing** — paste screenshots/files from phone into Claude Desktop sessions

---

## 5. Building a Moat

**What WON'T work as a moat:**
- The technical implementation — anyone can build keystroke injection + JSONL reading
- Being first — speed of entry doesn't matter if the product isn't sticky

**What WILL work:**

### A. Workflow/Context Accumulation (Data Moat)
- Agent Brain sees every conversation across providers. Over time, it builds a **personal knowledge graph** of what the user works on, their preferences, their codebase patterns.
- "Agent Brain knows I always approve Bash commands in my agent-brain repo" → auto-approve rules that learn from behavior
- "Agent Brain knows my coding style, my project structure, my team's conventions" → personalized system prompts that improve over time
- **The longer someone uses it, the smarter it gets for them.** This is hard to replicate because it's built on months of personal data.

### B. Plugin/Recipe Ecosystem (Community Moat)
- Let users create and share "recipes" — pre-built workflows like "deploy my app," "review this PR," "update my CRM from Slack"
- A marketplace of community-built integrations (Airtable, Notion, GitHub, Slack, Linear, etc.)
- **Network effect:** more users → more recipes → more valuable for new users → more users
- Think Raycast extensions, Homebrew formulae, or Zapier templates

### C. Multi-Provider Orchestration Intelligence (Product Moat)
- Smart routing: "this task is better for Claude" vs "this task is better for GPT" — learned from outcomes
- Cost optimization: route cheap tasks to cheaper models automatically
- **Cross-provider memory:** context from a Claude conversation available when you switch to GPT
- Nobody else is building the **orchestration layer across AI providers on your local machine**

### D. Trust & Brand (Community Moat)
- Open-source the core, build trust with developers
- Privacy-first positioning: "Your data never leaves your machine" — huge differentiator vs cloud-based orchestrators
- Developer community: Discord, shared configs, blog posts about workflows
- **The "runs on your machine" angle is a major trust signal** in the post-cloud era

### E. Enterprise/Team Features (Business Moat)
- Shared prompt libraries across a team
- Audit logs: who approved what, when
- Role-based access: junior devs need approval, seniors auto-approve
- SOC2/compliance angle: "AI usage that stays on-prem"

**The real moat formula:** Local-first privacy + accumulated personal context + community recipes. The longer someone uses Agent Brain, the more it knows about their workflow, and the more community recipes they've installed. Switching cost becomes very high.

---

## TL;DR Roadmap

1. **Now:** Add PWA support, WebSocket for real-time updates
2. **Month 1:** Package as single binary with install script, launch landing page
3. **Month 2:** Add Stripe subscriptions, auto-approve rules that learn from behavior
4. **Month 3:** Plugin/recipe system, community Discord
5. **Month 6:** Multi-Mac, team features, enterprise tier
