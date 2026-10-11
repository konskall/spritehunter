export async function fetchJsonWithRetry<T>(
  url: string,
  options: RequestInit & { retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const { retries = 2, timeoutMs = 12_000, ...requestOptions } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...requestOptions, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed");
}

