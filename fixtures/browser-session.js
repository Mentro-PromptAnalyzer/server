// Disposable browser contract substitute, not Supabase Auth or RLS evidence.
// This module is copied only to the separate fixture image.
const { randomBytes, randomUUID, createHmac } = require('node:crypto');
const signingKey = randomBytes(32);
const sessions = new Map();
const histories = new Map();
const accounts = [
  { id: '00000000-0000-4000-8000-000000000001', email: 'preview@example.test' },
  { id: '00000000-0000-4000-8000-000000000002', email: 'second@example.test' },
];

function createSession(account) {
  const now = Math.floor(Date.now() / 1000);
  const user = {
    ...account,
    aud: 'authenticated',
    role: 'authenticated',
    user_metadata: {},
    app_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: user.id,
      aud: user.aud,
      role: user.role,
      iat: now,
      exp: now + 3600,
      jti: randomUUID(),
    })
  ).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const token = `${unsigned}.${createHmac('sha256', signingKey).update(unsigned).digest('base64url')}`;
  sessions.set(token, { user, expires: now + 3600 });
  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: now + 3600,
    refresh_token: randomUUID(),
    user,
  };
}

function sessionUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer /, '');
  const session = sessions.get(token);
  return session && session.expires > Date.now() / 1000 ? session.user : null;
}

async function handleBrowserSession(req, res, url, json, readJson) {
  if (url.pathname === '/auth/v1/token') {
    if (req.method !== 'POST' || url.searchParams.get('grant_type') !== 'password') {
      json(res, 400, { message: 'Fixture supports password grant only' });
      return true;
    }
    const body = await readJson(req);
    const account = accounts.find((candidate) => candidate.email === body.email);
    if (!account || body.password !== 'preview-only') {
      json(res, 400, { message: 'Invalid fixture credentials' });
      return true;
    }
    json(res, 200, createSession(account));
    return true;
  }
  if (url.pathname === '/auth/v1/logout') {
    sessions.delete(req.headers.authorization?.replace(/^Bearer /, ''));
    res.writeHead(204);
    res.end();
    return true;
  }
  if (url.pathname !== '/rest/v1/chat_histories') return false;
  const user = sessionUser(req);
  if (!user) {
    json(res, 401, { message: 'Sign in to the local fixture' });
    return true;
  }
  if (req.method === 'POST') {
    const row = await readJson(req);
    if (row.user_id !== user.id || !row.analysis_result || typeof row.title !== 'string') {
      json(res, 403, { message: 'Invalid fixture history owner or payload' });
      return true;
    }
    const saved = { ...row, id: randomUUID(), created_at: new Date().toISOString() };
    histories.set(saved.id, saved);
    json(res, 201, [saved]);
    return true;
  }
  const rows = [...histories.values()].filter(
    (row) =>
      row.user_id === user.id &&
      (!url.searchParams.has('user_id') ||
        url.searchParams.get('user_id') === `eq.${row.user_id}`) &&
      (!url.searchParams.has('id') || url.searchParams.get('id') === `eq.${row.id}`)
  );
  if (req.method === 'DELETE') {
    rows.forEach((row) => histories.delete(row.id));
    json(res, 200, rows);
  } else if (req.method === 'GET') {
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (url.searchParams.get('order')?.includes('desc')) rows.reverse();
    json(res, 200, rows);
  } else json(res, 405, { message: 'Unsupported fixture operation' });
  return true;
}

module.exports = { handleBrowserSession, sessionUser };
