## Checkpoints (Claude Code Blocking Mode)
Claude Code sessions can use the blocking checkpoint flow directly.

```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
RESPONSE=$(curl -s --max-time 14410 -X POST http://localhost:3030/api/checkpoints \
  -H "Content-Type: application/json" \
  -d "{\"project_dir\": \"$PROJECT_KEY\", \"question\": \"<your question or plan summary here>\", \"options\": [\"Yes, proceed\", \"Modify approach\", \"Cancel\"]}")
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
