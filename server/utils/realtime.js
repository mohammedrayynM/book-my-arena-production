// Simple Server-Sent Events (SSE) broadcaster.
// Keeps the implementation minimal (no external deps) and works well for:
// - "new match request" popups
// - live match card updates (filled slots / full status)
// - live tournament scoring (per-channel streams below)

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

// ---- Channels ---------------------------------------------------------------------------------------
// A viewer of one match (or one tournament) should only be woken for that match / tournament, not for every
// score change on the platform. Channels are named e.g. "match:12" and "tournament:3".
const channels = new Map(); // name -> Set<res>
const MAX_CLIENTS_PER_CHANNEL = 2000;

// Opens an SSE response on `channel`. Returns false (and answers 503) when the channel is full.
function openChannelStream(channel, req, res) {
  const set = channels.get(channel) || new Set();
  if (set.size >= MAX_CLIENTS_PER_CHANNEL) {
    res.status(503).json({ success: false, error: 'Too many live viewers right now, retrying shortly' });
    return false;
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try { res.flushHeaders && res.flushHeaders(); } catch { /* ignore */ }
  writeEvent(res, 'connected', { ok: true, channel, ts: Date.now() });
  set.add(res);
  channels.set(channel, set);
  res.on('close', () => {
    set.delete(res);
    if (set.size === 0) channels.delete(channel);
  });
  return true;
}

function broadcastChannel(channel, event, data) {
  const set = channels.get(channel);
  if (!set || set.size === 0) return 0;
  let sent = 0;
  for (const res of set) {
    try { writeEvent(res, event, data); sent++; } catch { set.delete(res); }
  }
  return sent;
}

function channelSize(channel) {
  const set = channels.get(channel);
  return set ? set.size : 0;
}

// Keep connections from timing out behind proxies. The comment line also lets clients detect a dead link.
setInterval(() => {
  broadcastSse('ping', { ts: Date.now() });
  for (const set of channels.values()) {
    for (const res of set) {
      try { res.write(': ping\n\n'); } catch { set.delete(res); }
    }
  }
}, 20000).unref();

module.exports = {
  addSseClient,
  broadcastSse,
  openChannelStream,
  broadcastChannel,
  channelSize,
};
