// In-memory conversation history (replaces the Supabase `messages` table).
//
// Keyed by `${userId}:${sessionId}` with a bounded ring buffer per session.
// Multi-turn context survives within a container's lifetime and resets on
// restart/rebuild — the tradeoff chosen when Supabase was removed in FEAT-5.

export interface AppendArgs {
  userId: string;
  sessionId: string;
  content: string;
  langfuseTraceId?: string;
}

/** Row shape mirrors the columns the old Supabase `loadRecentMessages` selected. */
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: { text: string };
  tool_calls: unknown;
  tool_results: unknown;
  langfuse_trace_id: string | null;
  created_at: string;
}

const MAX_PER_SESSION = 200;
const sessions = new Map<string, StoredMessage[]>();

function keyFor(userId: string, sessionId: string) {
  return `${userId}:${sessionId}`;
}

function push(userId: string, sessionId: string, row: StoredMessage) {
  const key = keyFor(userId, sessionId);
  const list = sessions.get(key) ?? [];
  list.push(row);
  if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
  sessions.set(key, list);
}

export function appendUserMessage(a: AppendArgs) {
  push(a.userId, a.sessionId, {
    role: 'user',
    content: { text: a.content },
    tool_calls: null,
    tool_results: null,
    langfuse_trace_id: null,
    created_at: new Date().toISOString(),
  });
}

export function appendAssistantMessage(a: AppendArgs & { toolCalls?: unknown }) {
  push(a.userId, a.sessionId, {
    role: 'assistant',
    content: { text: a.content },
    tool_calls: a.toolCalls ?? null,
    tool_results: null,
    langfuse_trace_id: a.langfuseTraceId ?? null,
    created_at: new Date().toISOString(),
  });
}

export async function loadRecentMessages(a: {
  userId: string;
  sessionId: string;
  limit: number;
}): Promise<StoredMessage[]> {
  const list = sessions.get(keyFor(a.userId, a.sessionId)) ?? [];
  return list.slice(-a.limit);
}
