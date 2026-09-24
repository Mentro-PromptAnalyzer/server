import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const base = process.env.MENTRO_BASE_URL || 'http://127.0.0.1:3001';
const token = 'local-fixture-token';

async function jsonRequest(path, body, headers = {}) {
  const response = await fetch(new URL(path, base), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { response, body: await response.json() };
}

async function streamRequest(path, marker) {
  return fetch(new URL(path, base), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:8081',
    },
    body: JSON.stringify({ messages: [{ role: 'user', content: marker }] }),
    signal: AbortSignal.timeout(60_000),
  });
}

async function collectEvents(response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
  expect(response.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8081');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    for (const block of blocks) {
      const name = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (name && data) events.push({ name, data: JSON.parse(data), at: Date.now() });
    }
  }
  return events;
}

function fixtureMetrics() {
  const code =
    'fetch("http://127.0.0.1:3004/__fixture/metrics").then(r=>r.text()).then(console.log)';
  const output = execFileSync('docker', ['compose', 'exec', '-T', 'fixture', 'node', '-e', code], {
    encoding: 'utf8',
    env: process.env,
  });
  return JSON.parse(output.trim());
}

async function waitForBrowserPages(expected) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const actual = (await jsonRequest('/api/health')).body.browserPages;
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect((await jsonRequest('/api/health')).body.browserPages).toBe(expected);
}

describe.sequential('real Mentro container with isolated upstream fixtures', () => {
  it('reports Chromium readiness and enforces auth and CORS', async () => {
    const { response, body } = await jsonRequest('/api/health');
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, browser: true, supabaseConfigured: true });
    expect(body.browserPages).toBeGreaterThanOrEqual(1);

    const unauthenticated = await jsonRequest('/api/chat/stream', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(unauthenticated.response.status).toBe(401);

    const invalid = await jsonRequest(
      '/api/chat/stream',
      { messages: [{ role: 'user', content: 'hello' }] },
      { Authorization: 'Bearer invalid-token' }
    );
    expect(invalid.response.status).toBe(401);

    const preflight = await fetch(new URL('/api/chat/stream', base), {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:8081',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8081');

    const unapproved = await fetch(new URL('/api/health', base), {
      headers: { Origin: 'https://unapproved.example' },
    });
    expect(unapproved.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('counts local and controlled provider tokens, and rejects malformed bodies', async () => {
    for (const [provider, expected, estimationType] of [
      ['openai', 2, 'local_estimate'],
      ['gemini', 17, 'provider_count'],
      ['perplexity', 23, 'provider_count'],
    ]) {
      const { response, body } = await jsonRequest('/api/count-tokens', {
        provider,
        messages: [{ role: 'user', content: 'hello world' }],
      });
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ provider, inputTokens: expected, estimationType });
      expect(body.model).toEqual(expect.any(String));
    }
    for (const malformed of [
      null,
      {},
      { provider: 'unknown', messages: [] },
      {
        provider: 'openai',
        messages: [{ role: 'tool', content: 'hello' }],
      },
    ]) {
      const { response, body } = await jsonRequest('/api/count-tokens', malformed);
      expect(response.status).toBe(400);
      expect(body.error).toEqual(expect.any(String));
    }
  });

  it('extracts a fast share fixture and a real Chromium-rendered fixture, closing pages', async () => {
    const baseline = (await jsonRequest('/api/health')).body.browserPages;
    for (const [path, text] of [
      ['/share/fast', 'Explain the fixture route'],
      ['/share/browser', 'Summarize this controlled browser page'],
    ]) {
      const target = `https://chatgpt.com${path}`;
      const { response, body } = await jsonRequest(
        `/api/fetch-share?url=${encodeURIComponent(target)}`
      );
      expect(response.status).toBe(200);
      expect(body.html).toContain(`You: ${text}`);
      await waitForBrowserPages(baseline);
    }
    const gemini = await jsonRequest(
      `/api/fetch-share?url=${encodeURIComponent('https://gemini.google.com/share/browser')}`
    );
    expect(gemini.response.status).toBe(200);
    expect(gemini.body.html).toContain('You: Compare two controlled fixture ideas');
    await waitForBrowserPages(baseline);
    const unsupported = await jsonRequest(
      `/api/fetch-share?url=${encodeURIComponent('https://unapproved.example/share/id')}`
    );
    expect(unsupported.response.status).toBe(400);
  }, 25_000);

  it('returns a bounded extraction error and closes the Chromium page', async () => {
    const baseline = (await jsonRequest('/api/health')).body.browserPages;
    const target = 'https://chatgpt.com/share/no-content';
    const { response, body } = await jsonRequest(
      `/api/fetch-share?url=${encodeURIComponent(target)}`
    );
    expect(response.status).toBe(502);
    expect(body.error).toMatch(/could not extract/i);
    await waitForBrowserPages(baseline);
  }, 25_000);

  it('times out a hanging share page within the request deadline and closes the page', async () => {
    const baseline = (await jsonRequest('/api/health')).body.browserPages;
    const started = Date.now();
    const target = 'https://chatgpt.com/share/hang';
    const { response, body } = await jsonRequest(
      `/api/fetch-share?url=${encodeURIComponent(target)}`
    );
    expect(response.status).toBe(502);
    expect(body.error).toMatch(/could not load/i);
    expect(Date.now() - started).toBeLessThan(60_000);
    await waitForBrowserPages(baseline);
  }, 65_000);

  it('delivers incremental token events, tool fields, and completion before closing', async () => {
    const events = await collectEvents(await streamRequest('/api/chat/stream', '[fixture:tool]'));
    const tokens = events.filter((event) => event.name === 'token');
    const tool = events.find((event) => event.name === 'tool_call');
    const end = events.find((event) => event.name === 'end');
    expect(tokens.map((event) => event.data.text)).toEqual(['Hello ', 'world']);
    expect(tool.data.toolCalls[0].function.name).toBe('search');
    expect(end.data).toMatchObject({ done: true, tokenCount: 2, finishReason: 'tool_calls' });
    expect(end.data.usage.total_tokens).toBe(6);
    expect(end.data.toolCalls[0].function.arguments).toBe('{"q":"fixture"}');
    expect(end.at - tokens[0].at).toBeGreaterThanOrEqual(75);
  });

  it('delivers full chunks, fallback identity, usage, and assembled tool calls', async () => {
    const events = await collectEvents(
      await streamRequest('/api/chat/stream-full', '[fixture:fallback] [fixture:tool]')
    );
    const chunks = events.filter((event) => event.name === 'chunk');
    const end = events.find((event) => event.name === 'end');
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.some((event) => event.data.choices?.[0]?.delta?.tool_calls?.length)).toBe(true);
    expect(end.data).toMatchObject({
      done: true,
      provider: 'Cerebras',
      content: 'Hello world',
      finishReason: 'tool_calls',
    });
    expect(end.data.usage.total_tokens).toBe(6);
    expect(end.data.toolCalls[0].function.name).toBe('search');
    expect(end.at - chunks[0].at).toBeGreaterThanOrEqual(75);
  });

  it('preserves a fenced text tool call split across streamed chunks', async () => {
    const events = await collectEvents(
      await streamRequest('/api/chat/stream-full', '[fixture:text-tool]')
    );
    const chunks = events.filter((event) => event.name === 'chunk');
    const end = events.find((event) => event.name === 'end');
    expect(chunks[0].data.choices[0].delta.content).toContain('validate_');
    expect(chunks[1].data.choices[0].delta.content).toContain('location');
    expect(end.data.content).toBe(
      '```tool\n{"tool":"validate_location","arguments":{"address":"Denver, CO"}}\n```'
    );
    expect(end.data.usage.total_tokens).toBe(6);
    expect(end.data.done).toBe(true);
  });

  it('reports provider refusal, exhausted fallback, truncated stream, and timeout without false success', async () => {
    for (const path of ['/api/chat/stream', '/api/chat/stream-full']) {
      for (const [marker, code] of [
        ['[fixture:bad-request]', 'BAD_REQUEST'],
        ['[fixture:exhaust]', 'UPSTREAM_ERROR'],
        ['[fixture:incomplete]', 'STREAM_FAILURE'],
        ['[fixture:timeout]', 'TIMEOUT'],
      ]) {
        const events = await collectEvents(await streamRequest(path, marker));
        expect(events.some((event) => event.name === 'error' && event.data.code === code)).toBe(
          true
        );
        expect(events.some((event) => event.name === 'end')).toBe(false);
      }
    }
  }, 20_000);

  it('cancels an upstream stream when the client disconnects', async () => {
    for (const [path, event] of [
      ['/api/chat/stream', 'token'],
      ['/api/chat/stream-full', 'chunk'],
    ]) {
      const before = fixtureMetrics().cancelledStreams;
      const response = await streamRequest(path, '[fixture:disconnect]');
      expect(response.status).toBe(200);
      const reader = response.body.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain(`event: ${event}`);
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(fixtureMetrics().cancelledStreams).toBeGreaterThan(before);
    }
    expect((await jsonRequest('/api/health')).response.status).toBe(200);
  });

  it('rejects fixture substitution when started in production mode', () => {
    const image = `mentro-server-local:${process.env.MENTRO_REVISION}`;
    const result = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '-e',
        'NODE_ENV=production',
        '-e',
        'MENTRO_FIXTURE_ORIGIN=http://fixture:3004',
        image,
      ],
      { encoding: 'utf8', env: process.env }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('MENTRO_FIXTURE_ORIGIN is only allowed');

    const missingFixture = spawnSync(
      'docker',
      ['run', '--rm', '--network', 'none', '-e', 'NODE_ENV=test', image],
      {
        encoding: 'utf8',
        env: process.env,
      }
    );
    expect(missingFixture.status).not.toBe(0);
    expect(missingFixture.stderr).toContain('Test mode requires the isolated fixture origin');
  });

  it('reaches the API over the internal service hostname', () => {
    const code =
      'fetch("http://mentro-server:3001/api/health").then(r=>r.json()).then(x=>{if(!x.ok)process.exit(1);console.log(x.browser)})';
    const output = execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'fixture', 'node', '-e', code],
      {
        encoding: 'utf8',
        env: process.env,
      }
    );
    expect(output.trim()).toBe('true');
  });
});
