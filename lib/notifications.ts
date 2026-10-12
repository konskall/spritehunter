import type { ScoreBreakdown } from "@/lib/domain";

type Confidence = ScoreBreakdown["confidence"];

export interface AlertPreferences {
  minimumScore: number;
  confidence: Exclude<Confidence, "insufficient">;
  cooldown: number;
  quietStart: string;
  quietEnd: string;
}

export function shouldNotify(
  lastNotificationIso: string | null,
  now: Date,
  cooldownMinutes: number,
  previousScore: number | null,
  currentScore: number,
  minimumScore: number,
) {
  if (currentScore < minimumScore) return false;
  if (!lastNotificationIso) return true;
  const elapsedMinutes = (now.getTime() - new Date(lastNotificationIso).getTime()) / 60_000;
  const meaningfulEscalation = previousScore != null && currentScore - previousScore >= 15;
  return elapsedMinutes >= cooldownMinutes || meaningfulEscalation;
}

const minutesOfDay = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

/** Quiet window in device-local time; supports windows that wrap past midnight. */
export function isQuietTime(now: Date, start: string, end: string) {
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutesOfDay(start);
  const to = minutesOfDay(end);
  if (from === to) return false;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { insufficient: 0, low: 1, medium: 2, high: 3 };

export function meetsConfidence(actual: Confidence, minimum: Confidence) {
  return CONFIDENCE_RANK[actual] >= CONFIDENCE_RANK[minimum];
}

export function evaluateAlert({ score, confidence, last, prefs, now }: {
  score: number;
  confidence: Confidence;
  last: { at: string; score: number } | null;
  prefs: AlertPreferences;
  now: Date;
}) {
  return !isQuietTime(now, prefs.quietStart, prefs.quietEnd)
    && meetsConfidence(confidence, prefs.confidence)
    && shouldNotify(last?.at ?? null, now, prefs.cooldown, last?.score ?? null, score, prefs.minimumScore);
}
