import type { Metadata, Viewport } from "next";
import type { Language } from "@/lib/i18n";
import { CREATOR, LANGUAGE_PATHS, SEO_COPY } from "@/lib/seo-copy";
import { SITE_URL } from "@/lib/site";

const OTHER: Record<Language, Language> = { el: "en", en: "el" };

export const viewport: Viewport = {
  themeColor: "#07111d",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export function pageMetadata(language: Language): Metadata {
  const copy = SEO_COPY[language];
  const path = LANGUAGE_PATHS[language];
  return {
    metadataBase: new URL(SITE_URL),
    title: copy.title,
    description: copy.description,
    applicationName: "SpriteHunter",
    keywords: copy.keywords,
    authors: [CREATOR],
    creator: CREATOR.name,
    category: "science",
    manifest: "/manifest.webmanifest",
    alternates: {
      canonical: path,
      languages: { el: LANGUAGE_PATHS.el, en: LANGUAGE_PATHS.en, "x-default": LANGUAGE_PATHS.el },
    },
    robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 } },
    // Stops iOS from turning coordinates and other numbers into phone links.
    formatDetection: { telephone: false },
    icons: {
      icon: [
        { url: "/spritehunter-icon-192.png", type: "image/png", sizes: "192x192" },
        { url: "/spritehunter-icon-512.png", type: "image/png", sizes: "512x512" },
      ],
      shortcut: "/spritehunter-icon-192.png",
      apple: [{ url: "/apple-touch-icon.png", type: "image/png", sizes: "180x180" }],
    },
    openGraph: {
      type: "website",
      locale: copy.locale,
      alternateLocale: SEO_COPY[OTHER[language]].locale,
      url: path,
      siteName: "SpriteHunter",
      title: copy.title,
      description: copy.description,
      images: [{ url: "/spritehunter-og.jpg", width: 1200, height: 630, type: "image/jpeg", alt: copy.imageAlt }],
    },
    twitter: {
      card: "summary_large_image",
      title: copy.title,
      description: copy.description,
      images: ["/spritehunter-og.jpg"],
    },
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "SpriteHunter" },
  };
}

/** schema.org description of the app, serialised safely for an inline script tag. */
export function structuredDataJson(language: Language) {
  const copy = SEO_COPY[language];
  const data = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "SpriteHunter",
    alternateName: copy.alternateName,
    url: `${SITE_URL}${LANGUAGE_PATHS[language]}`,
    description: copy.description,
    image: `${SITE_URL}/spritehunter-og.jpg`,
    inLanguage: language,
    applicationCategory: "UtilitiesApplication",
    operatingSystem: "Web, Android, iOS",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
    author: { "@type": "Person", ...CREATOR },
    about: copy.about,
  };
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
