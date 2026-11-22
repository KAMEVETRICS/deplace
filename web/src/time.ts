/** "in 2 h", "5 min ago". */
export function relative(ms: number, now = Date.now()): string {
  const d = ms - now;
  const a = Math.abs(d);
  const unit = a < 3_600_000 ? [Math.max(1, Math.round(a / 60_000)), "min"] : a < 172_800_000 ? [Math.round(a / 3_600_000), "h"] : [Math.round(a / 86_400_000), "d"];
  return d >= 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}
