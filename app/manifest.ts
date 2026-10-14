import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SpriteHunter — Παρατηρητήριο Ανώτερης Ατμόσφαιρας",
    short_name: "SpriteHunter",
    description: "Πρόγνωση, στόχευση και φωτογράφιση Red Sprites και TLE από την Ελλάδα, με ζωντανούς κεραυνούς EUMETSAT MTG-LI.",
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
      { src: "/spritehunter-icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    screenshots: [
      { src: "/spritehunter-og.jpg", sizes: "1200x630", type: "image/jpeg", form_factor: "wide", label: "SpriteHunter — εντοπισμός καταιγίδων και στόχευση TLE" },
    ],
  };
}
