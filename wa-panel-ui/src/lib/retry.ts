// wa-panel-ui/src/lib/retry.ts
import type { AxiosResponse } from "axios";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function isNetErr(e: any) {
  return !!e && !e.response;
}

export async function requestWithRetry<T = any>(
  fn: () => Promise<AxiosResponse<T>>,
  opts?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number }
): Promise<AxiosResponse<T>> {
  const retries = opts?.retries ?? 10;
  const baseDelayMs = opts?.baseDelayMs ?? 400;
  const maxDelayMs = opts?.maxDelayMs ?? 2000;

  let lastErr: any = null;

  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;

      if (!isNetErr(e)) throw e;
      if (i === retries) break;

      const delay = Math.min(maxDelayMs, baseDelayMs + i * 300);
      await sleep(delay);
    }
  }

  throw lastErr;
}
