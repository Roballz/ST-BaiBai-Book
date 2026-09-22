import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import MiniSearch from 'minisearch';
import { LexicalIndex, tokenize, type LexicalRequest } from './bm25-index';

const request = (): LexicalRequest => ({ database: crypto.randomUUID(), scope: 'chat:A',
  documents: [{ id: 'A', text: '保管银色徽章编号 XJ42' }, { id: 'B', text: '在雨夜拜访车站' }],
  queries: ['XJ42'], exclude: [], topK: 5 });

it('中文和编号分词；命中后原生 IDB 重载索引，不重新添加全库文档', async () => {
  expect(tokenize('车站 ＸＪ４２')).toEqual(expect.arrayContaining(['车站', 'xj42']));
  const req = request();
  expect((await new LexicalIndex().search(req)).hits.map(h => h.id)).toEqual(['A']);
  const add = vi.spyOn(MiniSearch.prototype, 'add');
  try {
    const restored = await new LexicalIndex().search(req);
    expect(restored.persistent).toBe(true); expect(restored.hits.map(h => h.id)).toEqual(['A']);
    expect(add).not.toHaveBeenCalled();
  } finally { add.mockRestore(); }
});

it('编辑、删除、重复 Query、近期排除及 scope/角色隔离', async () => {
  const req = request(); const index = new LexicalIndex();
  const first = await index.search(req);
  expect((await index.search({ ...req, queries: ['XJ42', 'XJ42'] })).hits).toEqual(first.hits);
  expect((await index.search({ ...req, exclude: ['A'] })).hits).toEqual([]);
  req.documents[0].text = '徽章编号已经改为 ZZ99';
  expect((await index.search(req)).hits).toEqual([]);
  req.queries = ['ZZ99']; expect((await index.search(req)).hits[0].id).toBe('A');
  req.documents = req.documents.slice(1);
  expect((await index.search(req)).hits).toEqual([]);
  expect((await new LexicalIndex().search(req)).hits).toEqual([]);
  expect((await index.search({ ...request(), database: req.database, scope: 'chat:B', documents: [] })).hits).toEqual([]);
  expect((await index.search({ ...request(), documents: [] })).hits).toEqual([]);
});

it('索引持久化失败仍可本地检索，明确报告降级而不是误称已落盘', async () => {
  const tx = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => { throw new Error('quota'); });
  try {
    const result = await new LexicalIndex().search(request());
    expect(result.persistent).toBe(false); expect(result.hits.map(h => h.id)).toEqual(['A']);
  } finally { tx.mockRestore(); }
});
