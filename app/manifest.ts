import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SpriteHunter — Upper Atmosphere Observatory",
    short_name: "SpriteHunter",
    description: "Σχεδιασμός παρατήρησης και φωτογράφισης παροδικών φωτεινών φαινομένων.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#07111d",
    theme_color: "#07111d",
    orientation: "any",
    lang: "el",
    categories: ["weather", "photography", "education"],
    prefer_related_applications: false,
    icons: [
      { src: "/spritehunter-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/spritehunter-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/spritehunter-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    screenshots: [
      { src: "/spritehunter-og.png", sizes: "1200x630", type: "image/png", form_factor: "wide", label: "SpriteHunter — εντοπισμός καταιγίδων και στόχευση TLE" },
    ],
  };
}
