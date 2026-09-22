import SearchWorker from './bm25.worker?worker&inline';
import type { LexicalRequest, LexicalResult } from './bm25-index';

let worker: Worker | undefined;
let serial = 0;
/** 不把向量或原文复制给 Worker；只发送当前有效摘要。取消只撤销等待，旧结果不会应用。 */
export function searchBm25(request: LexicalRequest, signal?: AbortSignal): Promise<LexicalResult> {
  signal?.throwIfAborted();
  worker ??= new SearchWorker();
  const target = worker;
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer); target.removeEventListener('message', onMessage); target.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => { cleanup(); reject(error); };
    const onAbort = () => fail(signal?.reason || new Error('BM25 已取消'));
    const onError = () => {
      target.terminate(); if (worker === target) worker = undefined;
      fail(new Error('BM25 Worker 不可用'));
    };
    const onMessage = (event: MessageEvent<{ id: number; result: LexicalResult; error?: string }>) => {
      if (event.data.id !== id) return;
      cleanup();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result);
    };
    const timer = setTimeout(onError, 30_000);
    target.addEventListener('message', onMessage); target.addEventListener('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    try { target.postMessage({ id, request }); } catch (error) { fail(error); }
  });
}
