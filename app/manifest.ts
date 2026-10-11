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
    icons: [{ src: "/favicon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }],
  };
}
