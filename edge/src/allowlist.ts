export function isAllowedUser(
  userId: string | undefined,
  allowlistCsv: string,
): boolean {
  if (!userId) return false;
  const allowed = allowlistCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(userId);
}
