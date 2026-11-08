// Dedicated SSE broadcaster for Contact/Inbox messages (kept separate from match request SSE).
// This prevents leaking message events to non-admin SSE clients.

const clients = new Set();

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function addSseClient(res) {
  clients.add(res);

  // Send an initial event so the client knows the stream is alive.
  writeEvent(res, 'connected', { ok: true, ts: Date.now() });

  res.on('close', () => {
    clients.delete(res);
  });
}

function broadcastSse(event, data) {
  if (clients.size === 0) return;

  for (const res of clients) {
    try {
      writeEvent(res, event, data);
    } catch {
      clients.delete(res);
    }
  }
}

// Keep connections from timing out behind proxies.
setInterval(() => {
  broadcastSse('ping', { ts: Date.now() });
}, 25000).unref();

module.exports = {
  addSseClient,
  broadcastSse
};

