// Manual verification script for the WebSocket broadcast pipeline.
//
// Connects to /ws and posts a fresh metric to /api/metrics every 300ms
// (faster than the server's default 1000ms broadcast interval), so a
// passing run should show ~1 WS message per second with the interval
// between messages close to BROADCAST_INTERVAL_MS — proof that the
// server, not the POST rate, controls how often clients are updated.
//
// Usage: node scripts/ws-verify.mjs [baseUrl]
// Example: node scripts/ws-verify.mjs http://localhost:3001

import WebSocket from 'ws';

const baseUrl = process.argv[2] ?? 'http://localhost:3001';
const wsUrl = baseUrl.replace(/^http/, 'ws') + '/ws';
const MESSAGE_LIMIT = 5;

const ws = new WebSocket(wsUrl);
let lastTick = Date.now();
let count = 0;

ws.on('open', () => {
  console.log(`[ws] connected to ${wsUrl}`);
});

ws.on('message', (data) => {
  const now = Date.now();
  const delta = now - lastTick;
  lastTick = now;
  count += 1;
  console.log(`[ws] message #${count} (+${delta}ms):`, data.toString());
  if (count >= MESSAGE_LIMIT) {
    ws.close();
  }
});

ws.on('close', () => {
  console.log('[ws] closed');
  clearInterval(postTimer);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[ws] error', err);
  clearInterval(postTimer);
  process.exit(1);
});

const postTimer = setInterval(async () => {
  await fetch(`${baseUrl}/api/metrics`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      serverId: 'ws-verify-script',
      status: 'healthy',
      cpuUsage: Math.random() * 100,
      memoryUsage: Math.random() * 100,
      diskIo: Math.random() * 5,
    }),
  });
}, 300);
