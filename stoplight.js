// ---------------------------------------------------------------------------
// Stoplight — hosted bridge endpoints
//
// Replaces the localhost bridge from claude-stoplight. Each user registers a
// session token and uses it to POST state from Claude Code hooks and GET/SSE
// state from the Chrome extension.
//
// Endpoints:
//   POST /api/stoplight/register          — create a new session token
//   POST /api/stoplight/state             — update state (Bearer token)
//   GET  /api/stoplight/state/:token      — read current state
//   GET  /api/stoplight/events/:token     — SSE stream of state changes
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const { Router } = require('express');

const router = Router();

// ---------------------------------------------------------------------------
// In-memory store: token → { state, session, detail, since, updatedAt }
// ---------------------------------------------------------------------------
const sessions = new Map();
const sseClients = new Map(); // token → Set<res>

const VALID_STATES = new Set(['green', 'yellow', 'red', 'grey']);
const EXPIRY_MS = 15 * 60 * 1000; // 15 min → auto-grey
const CLEANUP_MS = 24 * 60 * 60 * 1000; // 24h → remove from memory

function defaultState() {
  return {
    state: 'grey',
    session: null,
    detail: 'no active session',
    since: Date.now(),
    updatedAt: Date.now(),
  };
}

function getSession(token) {
  return sessions.get(token) || null;
}

function broadcast(token) {
  const clients = sseClients.get(token);
  if (!clients || clients.size === 0) return;
  const data = JSON.stringify(sessions.get(token));
  for (const res of clients) {
    res.write(`data: ${data}\n\n`);
  }
}

// ---------------------------------------------------------------------------
// Auto-expire sessions to grey after 15 min of no updates
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [token, state] of sessions) {
    if (state.state !== 'grey' && now - state.updatedAt > EXPIRY_MS) {
      state.state = 'grey';
      state.detail = 'no active session';
      state.since = now;
      broadcast(token);
      console.log(`[stoplight] Token ${token.slice(0, 8)}… expired to grey`);
    }
  }
}, 30_000).unref();

// Cleanup stale sessions after 24h of inactivity
setInterval(
  () => {
    const now = Date.now();
    for (const [token, state] of sessions) {
      if (now - state.updatedAt > CLEANUP_MS) {
        sessions.delete(token);
        const clients = sseClients.get(token);
        if (clients) {
          for (const res of clients) res.end();
          sseClients.delete(token);
        }
        console.log(`[stoplight] Token ${token.slice(0, 8)}… cleaned up (24h inactive)`);
      }
    }
  },
  60 * 60 * 1000
).unref(); // check every hour

// ---------------------------------------------------------------------------
// POST /api/stoplight/register — create a new session token
// ---------------------------------------------------------------------------
router.post('/register', (_req, res) => {
  const token = crypto.randomUUID();
  sessions.set(token, defaultState());
  console.log(`[stoplight] Registered new token ${token.slice(0, 8)}…`);
  return res.json({ token });
});

// ---------------------------------------------------------------------------
// POST /api/stoplight/state — update state (Bearer token auth)
// Body: { state: "green"|"yellow"|"red"|"grey", session?: string, detail?: string }
// ---------------------------------------------------------------------------
router.post('/state', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  const token = match[1];
  if (!sessions.has(token)) {
    // Auto-register: if the token looks like a valid UUID, create the session
    // This allows users to pick their own token without calling /register first
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      sessions.set(token, defaultState());
      console.log(`[stoplight] Auto-registered token ${token.slice(0, 8)}…`);
    } else {
      return res.status(401).json({ error: 'Invalid token.' });
    }
  }

  const { state, session, detail } = req.body || {};

  if (!state || !VALID_STATES.has(state)) {
    return res.status(400).json({
      error: `state must be one of: ${[...VALID_STATES].join(', ')}`,
    });
  }

  const entry = sessions.get(token);
  const now = Date.now();
  const changed = state !== entry.state;

  if (changed) entry.since = now;
  entry.state = state;
  entry.session = session ?? entry.session;
  if (detail !== undefined) entry.detail = detail;
  entry.updatedAt = now;

  broadcast(token);
  console.log(`[stoplight] ${token.slice(0, 8)}… → ${state}${detail ? ` — ${detail}` : ''}`);

  return res.json(entry);
});

// ---------------------------------------------------------------------------
// GET /api/stoplight/state/:token — read current state
// ---------------------------------------------------------------------------
router.get('/state/:token', (req, res) => {
  const { token } = req.params;
  const entry = getSession(token);

  if (!entry) {
    return res.status(404).json({ error: 'Unknown token. Call /register first.' });
  }

  return res.json(entry);
});

// ---------------------------------------------------------------------------
// GET /api/stoplight/events/:token — SSE stream of state changes
// ---------------------------------------------------------------------------
router.get('/events/:token', (req, res) => {
  const { token } = req.params;
  const entry = getSession(token);

  if (!entry) {
    return res.status(404).json({ error: 'Unknown token. Call /register first.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(entry)}\n\n`);

  // Register this client
  if (!sseClients.has(token)) sseClients.set(token, new Set());
  sseClients.get(token).add(res);

  // Keepalive ping every 25s
  const keepalive = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(keepalive);
    const clients = sseClients.get(token);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(token);
    }
  });
});

function closeStoplightStreams() {
  for (const clients of sseClients.values()) {
    for (const res of clients) res.end();
  }
  sseClients.clear();
}

module.exports = { stoplightRouter: router, closeStoplightStreams };
