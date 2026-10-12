class HttpError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`HTTP ${status} ${statusText}`.trim());
  }
}

// Client errors will not succeed on retry; 429 and 5xx may.
const isRetryable = (error: unknown) => !(error instanceof HttpError) || error.status === 429 || error.status >= 500;

export async function fetchJsonWithRetry<T>(
  url: string,
  options: RequestInit & { retries?: number; timeoutMs?: number; deadlineMs?: number } = {},
): Promise<T> {
  const { retries = 2, timeoutMs = 12_000, deadlineMs = Number.POSITIVE_INFINITY, ...requestOptions } = options;
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    try {
      const response = await fetch(url, { ...requestOptions, signal: controller.signal });
      if (!response.ok) throw new HttpError(response.status, response.statusText);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error)) break;
      const backoff = 250 * 2 ** attempt;
      if (attempt < retries && deadline - Date.now() > backoff) await new Promise((resolve) => setTimeout(resolve, backoff));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}
