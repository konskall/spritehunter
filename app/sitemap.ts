import type { MetadataRoute } from "next";
import { LANGUAGE_PATHS } from "@/lib/seo-copy";
import { SITE_URL } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const languages = { el: `${SITE_URL}${LANGUAGE_PATHS.el}`, en: `${SITE_URL}${LANGUAGE_PATHS.en}` };
  return [
    { url: languages.el, lastModified: new Date(), changeFrequency: "daily", priority: 1, alternates: { languages } },
    { url: languages.en, lastModified: new Date(), changeFrequency: "daily", priority: 0.9, alternates: { languages } },
  ];
}
