export function isAllowedUser(
  userId: string | undefined,
  allowlistCsv: string | undefined,
): boolean {
  if (!userId) return false;
  const allowed = (allowlistCsv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(userId);
}
