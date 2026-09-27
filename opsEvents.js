const allowedMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function formatHttpEvent(method, status, durationMs) {
  const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0;
  const safeDuration = Number.isFinite(durationMs)
    ? Math.min(3_600_000, Math.max(0, Math.round(durationMs)))
    : 0;
  return (
    JSON.stringify({
      kind: 'ops',
      service: 'mentro-api',
      event: 'http.response',
      timestamp: new Date().toISOString(),
      level: safeStatus >= 500 ? 'error' : safeStatus >= 400 ? 'warn' : 'info',
      message: 'HTTP response',
      method: allowedMethods.has(method) ? method : 'OTHER',
      status: safeStatus,
      duration_ms: safeDuration,
    }) + '\n'
  );
}

module.exports = { formatHttpEvent };
