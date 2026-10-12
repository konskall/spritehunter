/** Parses an in-progress numeric field; returns null instead of 0 for empty or partial input. */
export function parseNumericDraft(text: string, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY) {
  const normalized = text.trim().replace(",", ".");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(normalized)) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}
