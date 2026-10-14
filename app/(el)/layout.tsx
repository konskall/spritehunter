import RootDocument from "@/components/RootDocument";
import { pageMetadata, viewport as siteViewport } from "@/lib/seo";
import "../globals.css";

export const metadata = pageMetadata("el");
export const viewport = siteViewport;

export default function GreekLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <RootDocument language="el">{children}</RootDocument>;
}
