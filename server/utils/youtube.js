// YouTube link validation for tournament live streams.
// Host-supplied URLs are never embedded as-is: we accept only real YouTube hosts, extract a strict
// 11-char video id (or a UC... channel id for "/channel/<id>/live"), and rebuild every URL ourselves.
// Clients embed `embed_url` (built here) - free text from the host never reaches an iframe.

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;

// Returns { kind, id, watch_url, embed_url } or { error }.
function parseYouTubeUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return { error: 'Enter a YouTube link' };
  if (raw.length > 500) return { error: 'That link is too long' };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { error: 'That is not a valid link' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { error: 'Only http(s) YouTube links are allowed' };
  if (url.username || url.password) return { error: 'That is not a valid YouTube link' };
  const host = url.hostname.toLowerCase();
  if (!YT_HOSTS.has(host)) return { error: 'Only YouTube links (youtube.com or youtu.be) are allowed' };

  const parts = url.pathname.split('/').filter(Boolean);
  let videoId = null;
  let channelId = null;

  if (host === 'youtu.be') {
    videoId = parts[0];
  } else if (parts[0] === 'watch') {
    videoId = url.searchParams.get('v');
  } else if (['live', 'embed', 'shorts', 'v'].includes(parts[0])) {
    videoId = parts[1];
    // /embed/live_stream?channel=UC... is YouTube's own "current live stream of a channel" embed
    if (parts[0] === 'embed' && parts[1] === 'live_stream') channelId = url.searchParams.get('channel');
  } else if (parts[0] === 'channel' && CHANNEL_ID.test(parts[1] || '') && parts[2] === 'live') {
    channelId = parts[1];
  }

  if (channelId && CHANNEL_ID.test(channelId)) {
    return {
      kind: 'channel_live',
      id: channelId,
      watch_url: `https://www.youtube.com/channel/${channelId}/live`,
      embed_url: `https://www.youtube-nocookie.com/embed/live_stream?channel=${channelId}&playsinline=1&rel=0`,
    };
  }
  if (videoId && VIDEO_ID.test(videoId)) {
    return {
      kind: 'video',
      id: videoId,
      watch_url: `https://www.youtube.com/watch?v=${videoId}`,
      embed_url: `https://www.youtube-nocookie.com/embed/${videoId}?playsinline=1&rel=0`,
    };
  }
  if (parts[0] && (parts[0].startsWith('@') || ['c', 'user'].includes(parts[0]))) {
    return { error: 'Channel-name links cannot be embedded. Open your live stream on YouTube, tap Share and paste that video link.' };
  }
  return { error: 'Could not find a YouTube video in that link. Paste the full video or live-stream link.' };
}

// Shape sent to clients for a stored link, or null when there is none / it no longer parses.
function youtubePayload(storedUrl) {
  if (!storedUrl) return null;
  const parsed = parseYouTubeUrl(storedUrl);
  if (parsed.error) return null;
  return { kind: parsed.kind, id: parsed.id, watch_url: parsed.watch_url, embed_url: parsed.embed_url };
}

module.exports = { parseYouTubeUrl, youtubePayload };
