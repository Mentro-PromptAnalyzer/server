// Deterministic upstreams for the local Compose pilot. This process has no
// production credentials and is not copied into the production server image.
const http = require('node:http');
const { handleBrowserSession, sessionUser } = require('./browser-session');

const TOKEN = 'local-fixture-token';
const ANON_KEY = 'local-fixture-anon';
let cancelledStreams = 0;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 300_000) throw new Error('Request too large');
  }
  return JSON.parse(body || '{}');
}

function writeSse(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture:3004');
  const origin = req.headers.origin;
  if (origin) {
    if (origin !== 'http://127.0.0.1:8081')
      return json(res, 403, { error: 'Unapproved fixture origin' });
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'authorization,apikey,content-type,x-client-info,prefer,x-supabase-api-version,accept-profile,content-profile'
    );
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (await handleBrowserSession(req, res, url, json, readJson)) return;
  } catch {
    return json(res, 400, { message: 'Invalid fixture request' });
  }

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  if (url.pathname === '/__fixture/metrics') {
    return json(res, 200, { cancelledStreams });
  }

  if (url.pathname === '/auth/v1/user') {
    const browserUser = sessionUser(req);
    const validKey = [ANON_KEY, 'sb_publishable_local_fixture'].includes(req.headers.apikey);
    if ((!browserUser && req.headers.authorization !== `Bearer ${TOKEN}`) || !validKey) {
      return json(res, 401, { error: 'Invalid fixture token' });
    }
    return json(res, 200, browserUser || { id: 'fixture-user-1' });
  }

  if (url.pathname === '/share-page') {
    const path = url.searchParams.get('path') || '';
    const host = url.searchParams.get('host') || '';
    if (host !== 'chatgpt.com' && host !== 'gemini.google.com') {
      return json(res, 400, { error: 'Unsupported fixture host' });
    }
    if (path.includes('hang')) return;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path.includes('fast')) {
      return res.end(
        '<!doctype html><script id="__NEXT_DATA__" type="application/json">' +
          JSON.stringify({
            conversation: [
              { author: { role: 'user' }, content: { parts: ['Explain the fixture route'] } },
            ],
          }) +
          '</script>'
      );
    }
    if (path.includes('browser')) {
      if (host === 'gemini.google.com') {
        return res.end(
          '<!doctype html><html><body><div class="query-text">Compare two controlled fixture ideas</div></body></html>'
        );
      }
      return res.end(
        '<!doctype html><html><body><div data-message-author-role="user">Summarize this controlled browser page</div></body></html>'
      );
    }
    return res.end('<!doctype html><html><body><p>No conversation here.</p></body></html>');
  }

  if (url.pathname === '/gemini-count-tokens' || url.pathname === '/perplexity-count-tokens') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    if (url.pathname === '/gemini-count-tokens') {
      if (!Array.isArray(body.contents)) return json(res, 400, { error: 'Missing contents' });
      return json(res, 200, { totalTokens: 17 });
    }
    if (!Array.isArray(body.messages)) return json(res, 400, { error: 'Missing messages' });
    return json(res, 200, { usage: { prompt_tokens: 23 } });
  }

  if (url.pathname === '/chat/completions') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return json(res, 400, { error: 'Invalid JSON' });
    }
    const marker = body.messages?.map((message) => message.content).join(' ') || '';
    const provider = req.headers.authorization;
    if (marker.includes('[fixture:bad-request]')) {
      return json(res, 400, { error: { message: 'Fixture rejected the request' } });
    }
    if (marker.includes('[fixture:fallback]') && provider === 'Bearer fixture-groq') {
      return json(res, 503, { error: { message: 'Primary fixture unavailable' } });
    }
    if (marker.includes('[fixture:exhaust]')) {
      return json(res, 503, { error: { message: 'Fixture upstream unavailable' } });
    }
    if (marker.includes('[fixture:timeout]')) return;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let completed = false;
    res.on('close', () => {
      if (!completed) cancelledStreams++;
    });

    const textTool = marker.includes('[fixture:text-tool]');
    const firstContent = textTool ? '```tool\n{"tool":"validate_' : 'Hello ';
    const secondContent = textTool
      ? 'location","arguments":{"address":"Denver, CO"}}\n```'
      : 'world';
    writeSse(res, { choices: [{ delta: { role: 'assistant', content: firstContent } }] });
    if (marker.includes('[fixture:disconnect]')) return;
    setTimeout(() => {
      if (res.destroyed) return;
      writeSse(res, {
        choices: [
          {
            delta: marker.includes('[fixture:tool]')
              ? {
                  content: secondContent,
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_fixture',
                      type: 'function',
                      function: { name: 'search', arguments: '{"q":"fixture"}' },
                    },
                  ],
                }
              : { content: secondContent },
            finish_reason: marker.includes('[fixture:tool]') ? 'tool_calls' : 'stop',
          },
        ],
      });
      writeSse(res, {
        choices: [],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
      if (marker.includes('[fixture:incomplete]')) {
        completed = true;
        return res.end();
      }
      res.write('data: [DONE]\n\n');
      completed = true;
      res.end();
    }, 150);
    return;
  }

  json(res, 404, { error: 'Unknown fixture path' });
});

server.listen(3004, '0.0.0.0', () => console.log('Fixture server listening on port 3004'));
