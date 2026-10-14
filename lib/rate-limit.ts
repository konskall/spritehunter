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

/**
 * The visitor's IP. Vercel sets x-real-ip and x-forwarded-for itself and drops values sent
 * by the client, so they cannot be spoofed there. A Cloudflare-only header was read first
 * before, which any client could set to a new value per request to escape the limits.
 */
export function clientKey(request: Request) {
  return request.headers.get("x-real-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "anonymous";
}
