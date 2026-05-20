import { Langfuse } from 'langfuse';

let instance: InstanceType<typeof Langfuse> | null = null;

export function getLangfuse(): InstanceType<typeof Langfuse> | null {
  if (instance) return instance;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const baseUrl = process.env.LANGFUSE_BASE_URL;
  if (!secretKey || !publicKey) {
    console.log('[langfuse] disabled (LANGFUSE_SECRET_KEY or LANGFUSE_PUBLIC_KEY not set)');
    return null;
  }
  instance = new Langfuse({ secretKey, publicKey, baseUrl });
  console.log('[langfuse] enabled');
  return instance;
}

export async function flushLangfuse(): Promise<void> {
  if (instance) await instance.flushAsync();
}
