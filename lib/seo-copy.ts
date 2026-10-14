import type { Language } from "@/lib/i18n";

/** Each language has its own address, so search engines index both and link them with hreflang. */
export const LANGUAGE_PATHS: Record<Language, string> = { el: "/", en: "/en" };

export const CREATOR = { name: "KonsKall", url: "https://www.linkedin.com/in/konstantinos-kalliakoudis-902b90103/" };

/** Page title and description per language; the app also applies them when the language is switched. */
export const SEO_COPY: Record<Language, { title: string; description: string; imageAlt: string; locale: string; keywords: string[]; alternateName: string; about: string[] }> = {
  el: {
    title: "SpriteHunter — Πρόγνωση & φωτογράφιση Red Sprites στην Ελλάδα",
    description: "Δωρεάν παρατηρητήριο Red Sprites και TLE: ζωντανοί κεραυνοί EUMETSAT MTG-LI, πρόγνωση καταιγίδων και ακριβής στόχευση κάμερας από την Ελλάδα.",
    imageAlt: "SpriteHunter — εντοπισμός και στόχευση Red Sprites και TLEs",
    locale: "el_GR",
    keywords: ["Red Sprites", "sprites", "TLE", "transient luminous events", "ELVES", "Blue Jets", "κεραυνοί", "καταιγίδες", "φωτογράφιση κεραυνών", "EUMETSAT MTG-LI", "αστροφωτογραφία", "Ελλάδα"],
    alternateName: "SpriteHunter — Παρατηρητήριο Ανώτερης Ατμόσφαιρας",
    about: ["Red sprite", "Transient luminous event", "Κεραυνός", "Καταιγίδα"],
  },
  en: {
    title: "SpriteHunter — Red Sprite forecasts & photography from Greece",
    description: "Free Red Sprite and TLE observatory: live EUMETSAT MTG-LI lightning, thunderstorm forecasts and precise camera aiming from Greece and the Mediterranean.",
    imageAlt: "SpriteHunter — finding and aiming at Red Sprites and TLEs",
    locale: "en_GB",
    keywords: ["Red Sprites", "sprites", "TLE", "transient luminous events", "ELVES", "Blue Jets", "lightning", "thunderstorms", "lightning photography", "EUMETSAT MTG-LI", "astrophotography", "Greece", "Mediterranean"],
    alternateName: "SpriteHunter — Upper Atmosphere Observatory",
    about: ["Red sprite", "Transient luminous event", "Lightning", "Thunderstorm"],
  },
};
