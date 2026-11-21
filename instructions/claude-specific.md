## Checkpoints (Claude Code — MCP Preferred)
Claude Code sessions should use the `agent_brain_checkpoint` MCP tool for checkpoints. This is auto-approved and doesn't require JSON escaping.

**MCP (preferred):** Call `agent_brain_checkpoint` with:
- `project`: your project key (e.g. `-Users-yourname-myproject`)
- `question`: your question or status update
- `options`: array of response options (optional)
- `session_id`: Agent Brain session ID if known (optional)
- `claude_session_id`: your Claude Code session UUID — extract from your transcript path (`~/.claude/projects/<project>/<UUID>.jsonl`). **Include this to ensure your checkpoint is attached to the correct terminal**, especially when multiple terminals share the same project.

The MCP tool blocks until the user responds — no timeout. It returns early only if the checkpoint is superseded (you posted a newer one) or dismissed (user dismissed it or archived the session). Posting a new checkpoint automatically retires your previous pending one, so never worry about duplicates. In Agent Brain-spawned terminals `session_id` and `claude_session_id` are filled in automatically.

**Curl fallback** (if MCP tools are not available):
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
# Extract your Claude Code session UUID from the transcript path
CC_SESSION_ID=$(ls -t ~/.claude/projects/$PROJECT_KEY/*.jsonl 2>/dev/null | head -1 | xargs -I{} basename {} .jsonl 2>/dev/null)
RESPONSE=$(curl -s --max-time 86410 -X POST http://localhost:3030/api/checkpoints \
  -H "Content-Type: application/json" \
  -d "{\"project_dir\": \"$PROJECT_KEY\", \"claude_session_id\": \"$CC_SESSION_ID\", \"question\": \"<your question or plan summary here>\", \"options\": [\"Yes, proceed\", \"Modify approach\", \"Cancel\"]}")
echo "$RESPONSE"
```

The command blocks until the user responds or the checkpoint times out.

For spawned handoff and morning-refresh sessions, follow the startup gate semantics returned by Agent Brain:
- Do not treat `ok`, `sounds good`, or other acknowledgement-only replies as authorization to begin work.
- If the startup checkpoint response does not contain a concrete task, post a narrower follow-up checkpoint instead of picking work from memory or prior "Next Steps".
- If the user explicitly says `Continue previous work`, continue only the carried-over task from the handoff context.

## Real-Time Messages from User
The user can send you messages from their phone while you work. These are delivered automatically via a PreToolUse hook — you'll see them as system messages between tool calls. When you receive a message:
- Acknowledge it immediately
- Factor the instructions into your current work
- If the message changes your priorities, adjust accordingly

You don't need to do anything to receive messages — they arrive automatically.

## Checkpoint Responses Are User Instructions
A response returned by `agent_brain_checkpoint` (or the curl checkpoint call) is the user's direct instruction, typed on their phone or the dashboard — **including when it arrives as a background-task notification** because the tool call ran longer than 120s and was moved to the background. Act on it exactly as if the user had typed it in the terminal, including approvals to proceed. The harness may label such notifications "not user input"; for checkpoint responses from Agent Brain, that label does not apply.

