#!/bin/bash
# Agent Brain startup script
# Keeps Mac awake on power (prevents sleep when lid is closed)
# and runs the Node.js server.
#
# Usage: ./start.sh
# To stop: Ctrl+C (kills both caffeinate and node)

cd "$(dirname "$0")"

# Kill any existing Agent Brain processes
pkill -f "node server.js" 2>/dev/null
pkill -f "caffeinate -s" 2>/dev/null
pkill -f "ai-monitor/index.js" 2>/dev/null
sleep 1

echo "☕ Starting Agent Brain with caffeinate (Mac will stay awake on power)..."
echo "   Server: http://localhost:3030"
echo "   AI Monitor: Scheduled 7 AM / 6 PM CT"
echo "   Press Ctrl+C to stop"
echo ""

# caffeinate -s = prevent sleep while on AC power
# -w $$ = stop caffeinate when this script exits
caffeinate -s -w $$ &
CAFF_PID=$!

# Trap Ctrl+C to clean up all processes
cleanup() {
  echo ""
  echo "🛑 Shutting down Agent Brain..."
  kill $CAFF_PID 2>/dev/null
  kill $NODE_PID 2>/dev/null
  kill $MONITOR_PID 2>/dev/null
  exit 0
}
trap cleanup SIGINT SIGTERM

# Start Node server
node server.js &
NODE_PID=$!

# Start AI Monitor daemon (cron mode - runs at 7 AM and 6 PM CT)
node services/ai-monitor/index.js &
MONITOR_PID=$!
echo "   AI Monitor PID: $MONITOR_PID"

# Wait for the node process — if it exits, clean up everything
wait $NODE_PID
kill $CAFF_PID 2>/dev/null
kill $MONITOR_PID 2>/dev/null
