const queue: Array<() => Promise<void>> = [];
let processing = false;

export function enqueueWrite(fn: () => Promise<void>) {
  queue.push(fn);
  if (!processing) drain();
}

async function drain() {
  processing = true;
  while (queue.length > 0) {
    const fn = queue.shift()!;
    try {
      await fn();
    } catch (e) {
      console.error('writeQueue', e);
    }
  }
  processing = false;
}

export async function flushQueue() {
  while (processing || queue.length > 0) {
    await new Promise((r) => setTimeout(r, 50));
  }
}
