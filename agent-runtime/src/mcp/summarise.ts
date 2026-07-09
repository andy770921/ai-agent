const SOFT_CAP = 4000;

export function softTruncate(s: string): string {
  if (s.length <= SOFT_CAP) return s;
  return s.slice(0, SOFT_CAP) + `\n…(truncated, original ${s.length} chars)`;
}
