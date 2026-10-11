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

