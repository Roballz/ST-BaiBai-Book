import { LexicalIndex, type LexicalRequest } from './bm25-index';
const index = new LexicalIndex();
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<{ id: number; request: LexicalRequest }>) => {
  const { id, request } = event.data;
  queue = queue.then(async () => {
    try { self.postMessage({ id, result: await index.search(request) }); }
    catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
};
