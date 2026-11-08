// Tiny in-memory fixed-window rate limiter (no dependency). Per-process, so it is a brake on abuse (brute-forcing QR
// tokens / booking codes, hammering checkout), not a distributed quota. `keyFn` picks who is being limited.
function rateLimit({ windowMs = 60000, max = 60, keyFn = (req) => req.ip, message = 'Too many requests. Please slow down.' } = {}) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset <= now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const key = String(keyFn(req));
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset <= now) { h = { count: 0, reset: now + windowMs }; hits.set(key, h); }
    h.count += 1;
    if (h.count > max) {
      res.set('Retry-After', String(Math.ceil((h.reset - now) / 1000)));
      return res.status(429).json({ success: false, error: message });
    }
    next();
  };
}
module.exports = { rateLimit };
