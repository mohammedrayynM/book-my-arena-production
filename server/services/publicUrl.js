// The public address people can actually open: invitation links, QR codes, emails. Never localhost / a LAN address /
// a dev tunnel — those only work on the developer's own machine, so they are ignored and the production domain is used.
const PRODUCTION_FALLBACK = 'https://bookarena.in';

function isLocalAddress(u) {
  return /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])|\.local(:|\/|$)|ngrok|loca\.lt|trycloudflare/i.test(String(u || ''));
}

/** Base URL of the public website, no trailing slash. PUBLIC_WEB_URL wins, then CLIENT_URL; development URLs only count outside production. */
function publicWebBase() {
  const prod = process.env.NODE_ENV === 'production';
  for (const candidate of [process.env.PUBLIC_WEB_URL, process.env.CLIENT_URL]) {
    const c = String(candidate || '').trim().replace(/\/+$/, '');
    if (!c) continue;
    if (prod && isLocalAddress(c)) continue;
    if (/^https?:\/\//i.test(c)) return c;
  }
  return PRODUCTION_FALLBACK;
}

/** The one invitation URL for a Find Players match: the same string is shown, copied, shared and encoded in the QR code. */
const inviteUrl = (shareToken) => `${publicWebBase()}/match-request/${encodeURIComponent(shareToken)}`;

/** The one invitation URL for a tournament: shown, copied, shared and encoded in the QR code. Matches the
 *  website's existing /tournaments/join/:token route, so the link opens a real page whether or not the app is installed. */
const tournamentInviteUrl = (joinToken) => `${publicWebBase()}/tournaments/join/${encodeURIComponent(joinToken)}`;

module.exports = { publicWebBase, inviteUrl, tournamentInviteUrl, isLocalAddress, PRODUCTION_FALLBACK };
