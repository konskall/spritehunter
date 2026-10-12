/**
 * Fixed-window limiter kept in instance memory. It is best-effort (each Worker
 * isolate counts separately) but stops bursts from exhausting public quotas.
 */
export function createRateLimiter({ limit, windowMs, maxKeys = 5_000 }: { limit: number; windowMs: number; maxKeys?: number }) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string, now = Date.now()) => {
    const current = windows.get(key);
    if (!current || now - current.start >= windowMs) {
      windows.delete(key);
      windows.set(key, { start: now, count: 1 });
      if (windows.size > maxKeys) windows.delete(windows.keys().next().value!);
      return true;
    }
    if (current.count >= limit) return false;
    current.count += 1;
    return true;
  };
}

export function clientKey(request: Request) {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "anonymous";
}
