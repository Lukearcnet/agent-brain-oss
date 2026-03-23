## Checkpoints (Codex Server-Held Wait Mode)
Use the `ab-checkpoint` wrapper for all Codex checkpoints. Do NOT rely on the Codex session itself to hold a 24-hour wait loop.

### Create checkpoint
```bash
export AB_SESSION_ID="<your session id from briefing>"
CHECKPOINT_ID=$(bin/ab-checkpoint ask "Your question here?" "Option 1" "Option 2" "Option 3")
echo "$CHECKPOINT_ID"
```

### Immediate short poll
```bash
RESPONSE=$(bin/ab-checkpoint wait-once "$CHECKPOINT_ID")
echo "$RESPONSE"
```

If the response JSON says `status: "pending"`, Agent Brain now owns the long wait for this session. The session does not need to keep a long local polling loop alive.

If it says `status: "responded"`, execute the user's instruction completely, then create the next checkpoint.

Agent Brain may also reactivate the Codex session automatically after a delayed response. If the session resumes and tells you a checkpoint response is ready, run `bin/ab-checkpoint consume` first.

### Why this flow
- Codex tends to background or abandon long-running local wait commands.
- Agent Brain keeps the waiting state and stores the response durably for the session.
- `bin/ab-checkpoint ask` persists the checkpoint id for recovery.
- `bin/ab-checkpoint wait-once` can still catch a quick reply.
- `bin/ab-checkpoint consume` lets a resumed session fetch the stored response cleanly.

### Recovery
If the session restarts or loses its place:
```bash
export AB_SESSION_ID="<your session id from briefing>"
bin/ab-checkpoint consume
```

With `AB_SESSION_ID` set:
- `bin/ab-checkpoint consume` returns a stored responded checkpoint if one is ready.
- `bin/ab-checkpoint wait-once` also works and will pick up a ready response automatically before falling back to a pending checkpoint.

## Real-Time Messages from User
For Codex sessions, real-time message injection is not yet supported. To receive user input during a session:
- Post a checkpoint and let Agent Brain hold the wait state
- Check the mailbox at logical breakpoints in your work
- The user can respond to checkpoints from their phone

This limitation may be removed in future versions when the Codex app-server protocol is stable.
