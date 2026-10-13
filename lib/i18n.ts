export type Language = "el" | "en";

/** Text produced on the server in both languages; the client shows the chosen one. */
export interface Localized {
  el: string;
  en: string;
}

export const tx = (el: string, en: string): Localized => ({ el, en });

/** "Unavailable (…)" with the provider's technical error, which stays as reported. */
export function unavailableText(error: unknown, fallback: string): Localized {
  const detail = error instanceof Error ? error.message : fallback;
  return tx(`Μη διαθέσιμο (${detail}).`, `Unavailable (${detail}).`);
}
