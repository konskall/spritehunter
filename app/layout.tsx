import type { Metadata, Viewport } from "next";
import PwaRegister from "@/components/PwaRegister";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpriteHunter — Upper Atmosphere Observatory",
  description: "Επιστημονικός σχεδιασμός παρατήρησης και φωτογράφισης Red Sprites από την Ελλάδα.",
  applicationName: "SpriteHunter",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg", apple: "/favicon.svg" },
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

