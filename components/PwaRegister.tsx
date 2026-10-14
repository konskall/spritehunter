"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Download, Share2, Smartphone, X } from "lucide-react";
import type { Language } from "@/lib/i18n";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

// The install prompt can fire before React hydrates, so it is captured at module load.
let installPrompt: BeforeInstallPromptEvent | null = null;
let installedThisSession = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installedThisSession = true;
    notify();
  });
}

const STANDALONE_QUERY = "(display-mode: standalone)";

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = window.matchMedia(STANDALONE_QUERY);
  media.addEventListener("change", listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", listener);
  };
}

const isInstalled = () => installedThisSession
  || window.matchMedia(STANDALONE_QUERY).matches
  || Boolean((navigator as NavigatorWithStandalone).standalone);
const isIosDevice = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const noopSubscribe = () => () => undefined;

/** Registers the service worker; the install entry point lives in the app top bar. */
export default function PwaRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }
  }, []);
  return null;
}

export function PwaInstallButton({ language }: { language: Language }) {
  const t = (el: string, en: string) => (language === "el" ? el : en);
  // Server snapshot reports "installed" so nothing renders before hydration.
  const installed = useSyncExternalStore(subscribe, isInstalled, () => true);
  const prompt = useSyncExternalStore(subscribe, () => installPrompt, () => null);
  const isIos = useSyncExternalStore(noopSubscribe, isIosDevice, () => false);
  const [showHelp, setShowHelp] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!showHelp) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showHelp]);

  const install = async () => {
    if (!prompt) {
      setShowHelp(true);
      return;
    }
    setInstalling(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      installPrompt = null;
      if (choice.outcome === "accepted") installedThisSession = true;
      notify();
    } finally {
      setInstalling(false);
    }
  };

  if (installed) return null;

  return (
    <>
      <button className="icon-button pwa-install-button" type="button" onClick={install} disabled={installing} title={t("Εγκατάσταση εφαρμογής", "Install app")} aria-label={t("Εγκατάσταση εφαρμογής", "Install app")} aria-haspopup={!prompt ? "dialog" : undefined}>
        <Download size={18} />
        <span>{installing ? t("Εγκατάσταση…", "Installing…") : t("Εγκατάσταση", "Install")}</span>
      </button>

      {/* Rendered into <body>: the top bar's backdrop-filter makes it the containing block for
          fixed children, which squeezed the overlay into the bar and pushed the dialog off-screen. */}
      {showHelp && createPortal(
        <div className="pwa-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelp(false); }}>
          <section className="pwa-dialog" role="dialog" aria-modal="true" aria-labelledby="pwa-dialog-title">
            <button className="pwa-dialog-close" type="button" onClick={() => setShowHelp(false)} aria-label={t("Κλείσιμο", "Close")}><X size={18} /></button>
            {/* eslint-disable-next-line @next/next/no-img-element -- static PWA icon, not an LCP image */}
            <img src="/spritehunter-icon-128.webp" width="64" height="64" alt="" />
            <span className="eyebrow">SPRITEHUNTER PWA</span>
            <h2 id="pwa-dialog-title">{t("Εγκατάσταση στο κινητό", "Install on your phone")}</h2>
            {isIos ? (
              <ol>
                <li><Share2 size={17} /><span>{t("Άνοιξε το SpriteHunter στο", "Open SpriteHunter in")} <strong>Safari</strong> {t("και πάτησε «Κοινή χρήση».", "and tap “Share”.")}</span></li>
                <li><Smartphone size={17} /><span>{t("Επίλεξε", "Choose")} <strong>{t("«Προσθήκη στην οθόνη Αφετηρίας»", "“Add to Home Screen”")}</strong>.</span></li>
                <li><CheckCircle2 size={17} /><span>{t("Ενεργοποίησε «Άνοιγμα ως εφαρμογή ιστού» και πάτησε", "Turn on “Open as Web App” and tap")} <strong>{t("«Προσθήκη»", "“Add”")}</strong>.</span></li>
              </ol>
            ) : (
              <ol>
                <li><Smartphone size={17} /><span>{t("Άνοιξε το μενού του browser", "Open the browser menu")} <strong>⋮</strong>.</span></li>
                <li><Download size={17} /><span>{t("Επίλεξε", "Choose")} <strong>{t("«Εγκατάσταση εφαρμογής»", "“Install app”")}</strong> {t("ή «Προσθήκη στην αρχική οθόνη».", "or “Add to Home screen”.")}</span></li>
                <li><CheckCircle2 size={17} /><span>{t("Επιβεβαίωσε την εγκατάσταση του SpriteHunter.", "Confirm the SpriteHunter installation.")}</span></li>
              </ol>
            )}
            <p>{t("Η εφαρμογή ανοίγει σε αυτόνομο παράθυρο. Το βασικό κέλυφος αποθηκεύεται για offline εκκίνηση, αλλά οι ζωντανοί χάρτες και τα μετεωρολογικά δεδομένα χρειάζονται σύνδεση.", "The app opens in its own window. The basic shell is stored for offline start, but live maps and weather data need a connection.")}</p>
          </section>
        </div>,
        document.body,
      )}
    </>
  );
}
