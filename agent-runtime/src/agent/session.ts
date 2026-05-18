/** Session ID = `{userId}:{yyyy-mm-dd}` (UTC). One session per user per day. */
export function sessionIdFor(userId: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${userId}:${yyyy}-${mm}-${dd}`;
}
