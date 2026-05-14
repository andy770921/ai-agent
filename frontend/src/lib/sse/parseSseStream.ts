export interface SseFrame {
  event?: string;
  data: string;
}

export interface ParseSseStreamOptions {
  signal?: AbortSignal;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {},
): AsyncIterable<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  // The reader takes a lock on the stream, so callers cannot cancel via
  // stream.cancel() — they must signal cancellation through us, and we
  // forward it to the reader.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | undefined;
  let data: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data = line.slice(5).trim();
  }
  if (data == null) return null;
  return event ? { event, data } : { data };
}
