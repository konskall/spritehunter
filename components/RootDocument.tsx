import PwaRegister from "@/components/PwaRegister";
import type { Language } from "@/lib/i18n";
import { structuredDataJson } from "@/lib/seo";

// Runs before the page paints: a visitor who chose the other language goes straight to its
// address, instead of seeing this language until the app loads (the installed app always
// starts at "/"). Search engines have no stored choice and stay on the page they asked for.
const LANGUAGE_REDIRECT = `try{var c=JSON.parse(localStorage.getItem("spritehunter.language-choice")||"null");if(c!=="el"&&c!=="en")c=JSON.parse(localStorage.getItem("spritehunter.language")||"null")==="en"?"en":null;var p=c==="en"?"/en":c==="el"?"/":null;if(p&&p!==location.pathname)location.replace(p+location.search+location.hash)}catch(e){}`;

/** The <html> shell shared by the Greek (/) and English (/en) root layouts. */
export default function RootDocument({ language, children }: Readonly<{ language: Language; children: React.ReactNode }>) {
  return (
    <html lang={language}>
      <body>
        <script dangerouslySetInnerHTML={{ __html: LANGUAGE_REDIRECT }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredDataJson(language) }} />
        <PwaRegister />
        {children}
      </body>
    </html>
  );
}
