"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Download, Share2, Smartphone, X } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

function isStandalone() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || Boolean((navigator as NavigatorWithStandalone).standalone);
}

export default function PwaRegister() {
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(true);
  const [ready, setReady] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    setInstalled(isStandalone());
    setIsIos(/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
    setReady(true);

    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
    }

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
      setInstalled(false);
    };
    const onInstalled = () => {
      setInstalled(true);
      setInstallPrompt(null);
      setShowHelp(false);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!showHelp) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showHelp]);

  const install = async () => {
    if (!installPrompt) {
      setShowHelp(true);
      return;
    }
    setInstalling(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (choice.outcome === "accepted") setInstalled(true);
    } finally {
      setInstalling(false);
    }
  };

  if (!ready || installed) return null;

  return (
    <>
      <button className="pwa-install-chip" type="button" onClick={install} disabled={installing} aria-haspopup={!installPrompt ? "dialog" : undefined}>
        <Download size={17} />
        <span>{installing ? "Εγκατάσταση…" : "Εγκατάσταση εφαρμογής"}</span>
      </button>

      {showHelp && (
        <div className="pwa-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowHelp(false); }}>
          <section className="pwa-dialog" role="dialog" aria-modal="true" aria-labelledby="pwa-dialog-title">
            <button className="pwa-dialog-close" type="button" onClick={() => setShowHelp(false)} aria-label="Κλείσιμο"><X size={18} /></button>
            <img src="/spritehunter-icon-192.png" width="64" height="64" alt="" />
            <span className="eyebrow">SPRITEHUNTER PWA</span>
            <h2 id="pwa-dialog-title">Εγκατάσταση στο κινητό</h2>
            {isIos ? (
              <ol>
                <li><Share2 size={17} /><span>Άνοιξε το SpriteHunter στο <strong>Safari</strong> και πάτησε «Κοινή χρήση».</span></li>
                <li><Smartphone size={17} /><span>Επίλεξε <strong>«Προσθήκη στην οθόνη Αφετηρίας»</strong>.</span></li>
                <li><CheckCircle2 size={17} /><span>Ενεργοποίησε «Άνοιγμα ως εφαρμογή ιστού» και πάτησε <strong>«Προσθήκη»</strong>.</span></li>
              </ol>
            ) : (
              <ol>
                <li><Smartphone size={17} /><span>Άνοιξε το μενού του browser <strong>⋮</strong>.</span></li>
                <li><Download size={17} /><span>Επίλεξε <strong>«Εγκατάσταση εφαρμογής»</strong> ή «Προσθήκη στην αρχική οθόνη».</span></li>
                <li><CheckCircle2 size={17} /><span>Επιβεβαίωσε την εγκατάσταση του SpriteHunter.</span></li>
              </ol>
            )}
            <p>Η εφαρμογή ανοίγει σε αυτόνομο παράθυρο. Το βασικό κέλυφος αποθηκεύεται για offline εκκίνηση, αλλά οι ζωντανοί χάρτες και τα μετεωρολογικά δεδομένα χρειάζονται σύνδεση.</p>
          </section>
        </div>
      )}
    </>
  );
}
