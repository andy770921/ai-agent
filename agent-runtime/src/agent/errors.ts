/** Detect context-length errors across providers (heuristic). */
export function isContextLengthError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return (
    m.includes('context') &&
    (m.includes('length') || m.includes('window') || m.includes('token'))
  );
}
