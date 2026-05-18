// Contract for live agent activity, shared between the agent-runtime container,
// the Cloudflare edge Worker, and the dashboard frontend.
//
// One line emitted by the agent runtime = one of the AgentEvent variants below.
// The container's events emitter reshapes Gemini CLI telemetry into this shape
// before fanning out to /events/stream.

export interface AgentEventBase {
  sessionUserId: string;
  ts: string;
}

export interface AgentMessageIn extends AgentEventBase {
  type: 'message_in';
  text: string;
}

export interface AgentToolCall extends AgentEventBase {
  type: 'tool_call';
  tool: string;
  args: unknown;
}

export interface AgentToolResult extends AgentEventBase {
  type: 'tool_result';
  tool: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface AgentMessageOut extends AgentEventBase {
  type: 'message_out';
  text: string;
  kind: 'text' | 'image';
  imageUrl?: string;
}

export interface SessionEnded extends AgentEventBase {
  type: 'session_ended';
}

export type AgentEvent =
  | AgentMessageIn
  | AgentToolCall
  | AgentToolResult
  | AgentMessageOut
  | SessionEnded;

export interface SessionSummary {
  userId: string;
  lastSeen: string;
  msgCount: number;
  lastEvent?: AgentEvent;
}
