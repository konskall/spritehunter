import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SpriteHunter — Upper Atmosphere Observatory",
    short_name: "SpriteHunter",
    description: "Σχεδιασμός παρατήρησης και φωτογράφισης παροδικών φωτεινών φαινομένων.",
    start_url: "/",
    display: "standalone",
    background_color: "#07111d",
    theme_color: "#07111d",
    orientation: "any",
    lang: "el",
    icons: [
      { src: "/spritehunter-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/spritehunter-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
