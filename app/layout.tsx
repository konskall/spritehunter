import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/PwaRegister";
import "./globals.css";

const SITE_URL = "https://spritehunter-observatory.peppystar32.chatgpt.site";
const TITLE = "SpriteHunter — Πρόγνωση & φωτογράφιση Red Sprites στην Ελλάδα";
const DESCRIPTION = "Δωρεάν παρατηρητήριο Red Sprites και TLE: ζωντανοί κεραυνοί EUMETSAT MTG-LI, πρόγνωση καταιγίδων και ακριβής στόχευση κάμερας από την Ελλάδα.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "SpriteHunter",
  keywords: ["Red Sprites", "sprites", "TLE", "transient luminous events", "ELVES", "Blue Jets", "κεραυνοί", "καταιγίδες", "φωτογράφιση κεραυνών", "EUMETSAT MTG-LI", "αστροφωτογραφία", "Ελλάδα"],
  authors: [{ name: "SpriteHunter" }],
  creator: "SpriteHunter",
  category: "science",
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
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
    locale: "el_GR",
    url: "/",
    siteName: "SpriteHunter",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/spritehunter-og.png", width: 1200, height: 630, alt: "SpriteHunter — εντοπισμός και στόχευση Red Sprites και TLEs" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/spritehunter-og.png"],
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "SpriteHunter" },
};

export const viewport: Viewport = {
  themeColor: "#07111d",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

const structuredData = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "SpriteHunter",
  alternateName: "SpriteHunter — Παρατηρητήριο Ανώτερης Ατμόσφαιρας",
  url: `${SITE_URL}/`,
  description: DESCRIPTION,
  image: `${SITE_URL}/spritehunter-og.png`,
  inLanguage: "el",
  applicationCategory: "UtilitiesApplication",
  operatingSystem: "Web, Android, iOS",
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
  about: ["Red sprite", "Transient luminous event", "Κεραυνός", "Καταιγίδα"],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="el">
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, "\\u003c") }} />
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
