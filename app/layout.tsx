import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/PwaRegister";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://spritehunter-observatory.peppystar32.chatgpt.site"),
  title: "SpriteHunter — Upper Atmosphere Observatory",
  description: "Επιστημονικός σχεδιασμός παρατήρησης και φωτογράφισης Red Sprites από την Ελλάδα.",
  applicationName: "SpriteHunter",
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
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
    title: "SpriteHunter — Παρατηρητήριο Ανώτερης Ατμόσφαιρας",
    description: "Εντοπισμός καταιγίδων, επιστημονική στόχευση και φωτογράφιση Red Sprites και TLEs από την Ελλάδα.",
    images: [{ url: "/spritehunter-og.png", width: 1200, height: 630, alt: "SpriteHunter — εντοπισμός και στόχευση Red Sprites και TLEs" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "SpriteHunter — Παρατηρητήριο Ανώτερης Ατμόσφαιρας",
    description: "Εντοπισμός καταιγίδων και στόχευση για Red Sprites και TLEs.",
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

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="el"><body><PwaRegister />{children}</body></html>;
}
