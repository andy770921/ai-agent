import { db } from './client.js';
import { enqueueWrite } from './writeQueue.js';

export interface AppendArgs {
  userId: string;
  sessionId: string;
  content: string;
  langfuseTraceId?: string;
}

export function appendUserMessage(a: AppendArgs) {
  enqueueWrite(async () => {
    await db().from('messages').insert({
      user_id: a.userId,
      session_id: a.sessionId,
      role: 'user',
      content: { text: a.content },
    });
  });
}

export function appendAssistantMessage(
  a: AppendArgs & { toolCalls?: unknown },
) {
  enqueueWrite(async () => {
    await db().from('messages').insert({
      user_id: a.userId,
      session_id: a.sessionId,
      role: 'assistant',
      content: { text: a.content },
      tool_calls: a.toolCalls ?? null,
      langfuse_trace_id: a.langfuseTraceId ?? null,
    });
  });
}

export async function loadRecentMessages(a: {
  userId: string;
  sessionId: string;
  limit: number;
}) {
  const r = await db()
    .from('messages')
    .select('role, content, tool_calls, tool_results, created_at')
    .eq('user_id', a.userId)
    .eq('session_id', a.sessionId)
    .order('created_at', { ascending: true })
    .limit(a.limit);
  if (r.error) throw r.error;
  return r.data ?? [];
}
