import { expect, it } from 'vitest';

const fixture = 'http://127.0.0.1:3004';
const origin = 'http://127.0.0.1:8081';
async function request(
  path,
  { token, body, method = body ? 'POST' : 'GET', requestOrigin = origin } = {}
) {
  return fetch(`${fixture}${path}`, {
    method,
    headers: {
      Origin: requestOrigin,
      apikey: 'sb_publishable_local_fixture',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}
async function login(email) {
  const response = await request('/auth/v1/token?grant_type=password', {
    body: { email, password: 'preview-only' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  return response.json();
}

it('supports the browser session/stream contract while isolating disposable history and rejecting invalid sessions', async () => {
  expect(
    (
      await request('/auth/v1/token?grant_type=password', {
        body: { email: 'preview@example.test', password: 'wrong' },
      })
    ).status
  ).toBe(400);
  const denied = await request('/healthz', { requestOrigin: 'https://unapproved.example' });
  expect(denied.status).toBe(403);
  expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  const preflight = await fetch(`${fixture}/rest/v1/chat_histories`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,apikey,accept-profile,content-profile',
    },
  });
  expect(preflight.status).toBe(204);
  for (const header of ['authorization', 'apikey', 'accept-profile', 'content-profile']) {
    expect(preflight.headers.get('access-control-allow-headers')).toContain(header);
  }
  const first = await login('preview@example.test');
  const second = await login('second@example.test');
  const token = first.access_token;
  const stream = await fetch('http://127.0.0.1:3001/api/chat/stream', {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Controlled browser contract' }] }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(stream.status).toBe(200);
  const events = await stream.text();
  expect(events).toContain('Hello ');
  expect(events).toContain('world');
  expect(events).toContain('event: end');
  expect(events).toContain('"done":true');
  expect((await request('/rest/v1/chat_histories')).status).toBe(401);
  const saved = await request('/rest/v1/chat_histories', {
    token,
    body: {
      user_id: first.user.id,
      title: 'Disposable integration',
      analysis_result: { prompts: [] },
    },
  });
  expect(saved.status).toBe(201);
  const [row] = await saved.json();
  expect(
    await (await request(`/rest/v1/chat_histories?id=eq.${row.id}`, { token })).json()
  ).toHaveLength(1);
  expect(
    await (
      await request(`/rest/v1/chat_histories?id=eq.${row.id}`, { token: second.access_token })
    ).json()
  ).toEqual([]);
  expect(
    (
      await request('/rest/v1/chat_histories', {
        token: second.access_token,
        body: { user_id: first.user.id, title: 'Denied', analysis_result: {} },
      })
    ).status
  ).toBe(403);
  await request(`/rest/v1/chat_histories?id=eq.${row.id}`, { token, method: 'DELETE' });
  expect(
    await (await request(`/rest/v1/chat_histories?id=eq.${row.id}`, { token })).json()
  ).toEqual([]);
  await request('/auth/v1/logout', { token, method: 'POST' });
  expect((await request('/auth/v1/user', { token })).status).toBe(401);
}, 20_000);
