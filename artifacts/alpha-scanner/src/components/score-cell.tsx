// Old Bullet Score is random (AUC ~0.5) on these patterns; hidden until a new score exists.
export const BULLET_SCORE_HIDDEN_PATTERNS = new Set([
  "price_led_momentum",
  "impulse_buy",
  "neon_support_bounce",
]);

export function ScoreCell({ s }: { s: any }) {
  if (
    s.alphaScore == null ||
    BULLET_SCORE_HIDDEN_PATTERNS.has(s.sentimentKey ?? "")
  ) {
    return <span className="text-muted-foreground">—</span>;
  }
  const score = s.alphaScore as number;
  return (
    <span
      className={
        score >= 8
          ? "text-yellow-300"
          : score >= 6
            ? "text-blue-300"
            : "text-green-400"
      }
    >
      {score}/10 {"█".repeat(Math.round(score))}
      {"░".repeat(10 - Math.round(score))}
    </span>
  );
}
