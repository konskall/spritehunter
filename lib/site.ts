// Public address of the deployment, for canonical links, Open Graph, robots.txt and the
// sitemap. Vercel provides the production host at build and run time; SITE_URL overrides
// it, for example after adding a custom domain.
const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export const SITE_URL = (process.env.SITE_URL ?? (vercelHost ? `https://${vercelHost}` : "http://localhost:3000")).replace(/\/+$/, "");
