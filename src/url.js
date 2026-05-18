export function sanitizeUrl(rawUrl) {
  const value = String(rawUrl || '');
  try {
    const url = new URL(value);
    const queryKeys = Array.from(new Set(Array.from(url.searchParams.keys()))).sort();
    const origin = url.protocol === 'file:' ? 'file://' : url.origin;
    return {
      origin,
      path: url.pathname || '/',
      queryKeys,
      hasHash: Boolean(url.hash),
      display: `${origin}${url.pathname || '/'}${queryKeys.length ? `?${queryKeys.map(k => `${k}=...`).join('&')}` : ''}${url.hash ? '#...' : ''}`
    };
  } catch {
    return {
      invalid: true,
      display: value.slice(0, 200)
    };
  }
}

export function summarizeUrlList(entries) {
  const byOrigin = new Map();
  const byResourceType = new Map();
  let failed = 0;

  for (const entry of entries) {
    const origin = entry.url?.origin || 'invalid';
    byOrigin.set(origin, (byOrigin.get(origin) || 0) + 1);
    byResourceType.set(entry.resourceType || 'unknown', (byResourceType.get(entry.resourceType || 'unknown') || 0) + 1);
    if (entry.failure) failed++;
  }

  return {
    total: entries.length,
    failed,
    byOrigin: Object.fromEntries(Array.from(byOrigin.entries()).sort((a, b) => b[1] - a[1])),
    byResourceType: Object.fromEntries(Array.from(byResourceType.entries()).sort((a, b) => b[1] - a[1]))
  };
}
