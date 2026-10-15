// Lets Node run the app's TypeScript directly: resolves "@/..." to the repository root and adds
// the extension TypeScript imports leave out.
const ROOT = new URL("../../", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const base = ROOT + specifier.slice(2);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
      try {
        return await next(candidate, context);
      } catch {
        // try the next form
      }
    }
  }
  return next(specifier, context);
}
