import RootDocument from "@/components/RootDocument";
import { pageMetadata, viewport as siteViewport } from "@/lib/seo";
import "../globals.css";

export const metadata = pageMetadata("en");
export const viewport = siteViewport;

export default function EnglishLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <RootDocument language="en">{children}</RootDocument>;
}
