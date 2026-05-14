import { parseSseStream, type SseFrame } from './parseSseStream';

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseFrame[]> {
  const out: SseFrame[] = [];
  for await (const frame of parseSseStream(stream)) out.push(frame);
  return out;
}

describe('parseSseStream', () => {
  it('parses a single frame with event + data', async () => {
    const frames = await collect(streamFromChunks(['event: msg\ndata: hello\n\n']));
    expect(frames).toEqual([{ event: 'msg', data: 'hello' }]);
  });

  it('parses a data-only frame', async () => {
    const frames = await collect(streamFromChunks(['data: solo\n\n']));
    expect(frames).toEqual([{ data: 'solo' }]);
  });

  it('reassembles a frame split across chunks', async () => {
    const frames = await collect(streamFromChunks(['event: ', 'tool_call\ndata: {"a"', ':1}\n\n']));
    expect(frames).toEqual([{ event: 'tool_call', data: '{"a":1}' }]);
  });

  it('emits multiple frames from one chunk', async () => {
    const frames = await collect(
      streamFromChunks(['data: one\n\ndata: two\n\nevent: x\ndata: three\n\n']),
    );
    expect(frames).toEqual([{ data: 'one' }, { data: 'two' }, { event: 'x', data: 'three' }]);
  });

  it('skips frames without a data line', async () => {
    const frames = await collect(streamFromChunks([': comment-only\n\ndata: kept\n\n']));
    expect(frames).toEqual([{ data: 'kept' }]);
  });

  it('drops a trailing partial frame at stream end', async () => {
    const frames = await collect(streamFromChunks(['data: complete\n\ndata: partial']));
    expect(frames).toEqual([{ data: 'complete' }]);
  });
});
