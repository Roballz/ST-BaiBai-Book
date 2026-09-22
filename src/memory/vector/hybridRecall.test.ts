import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as engine from '../engine';
import * as indexing from './index';
import * as scope from './scope';
import * as store from './store';
import * as embed from './embed';
import * as rewrite from './rewrite';
import * as bm25 from './bm25';
import { LexicalIndex } from './bm25-index';
import { recallDebug } from './debug';
import { clearRecallInjection, runVectorRecall } from './recall';

const original = JSON.parse(JSON.stringify(settings.apiSettings.vector));
let chatId: string;
let inject: ReturnType<typeof vi.fn>;
let leaves: ReturnType<typeof indexing.collectLeaves>;
const finalText = () => String(inject.mock.calls.at(-1)?.[1] ?? '');
beforeEach(() => {
  chatId = 'A'; inject = vi.fn();
  const cache = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => cache.get(k) ?? null,
    setItem: (k: string, v: string) => cache.set(k, v), removeItem: (k: string) => cache.delete(k) });
  settings.apiSettings.vector.enabled = true; settings.apiSettings.vector.knowledge.enabled = false;
  Object.assign(settings.apiSettings.vector.recall, { minAiFloors: 0, rerankCandidates: 4, bm25Candidates: 5,
    fusionCandidates: 1, bm25Count: 2, finalRecallCount: 4, fullTextCount: 1, embeddingThreshold: 0.8, rerankThreshold: 0.9 });
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(scope, 'currentVectorDb').mockReturnValue(crypto.randomUUID());
  vi.spyOn(scope, 'currentChatId').mockImplementation(() => chatId);
  vi.spyOn(scope, 'currentChatScope').mockImplementation(() => `chat:${chatId}`);
  vi.spyOn(scope, 'recallScopes').mockImplementation(() => [`chat:${chatId}`]);
  vi.spyOn(scope, 'currentBundleHashes').mockReturnValue([]);
  const chat = [{ is_user: false, mes: '旧剧情' }, { is_user: true, mes: 'XJ42' }] as STMessage[];
  vi.spyOn(context, 'getContext').mockReturnValue({ chat, setExtensionPrompt: inject } as unknown as STContext);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(1);
  leaves = ['A', 'B', 'C', 'D'].map((id, i) => ({ leafId: id, docHash: id, payloadHash: id,
    document: `${id} 摘要 XJ42`, mesFull: `${id} 原文`, storyTime: '', msgIndex: i }));
  vi.spyOn(indexing, 'collectLeaves').mockImplementation(() => leaves.map(l => ({ ...l })));
  vi.spyOn(indexing, 'ensureRecallIndex').mockResolvedValue(undefined);
  vi.spyOn(embed, 'embedTexts').mockImplementation(async texts => texts.map(() => new Float32Array([1, 0])));
  vi.spyOn(rewrite, 'rewriteQuery').mockResolvedValue({ intent: '回忆徽章', queries: ['徽章'] });
  vi.spyOn(store, 'vecSearch').mockResolvedValue({ results: leaves.filter(l => ['A', 'D'].includes(l.leafId)).map(l => ({
    ...l, scope: 'chat:A', similarity: 0.85, queryIndex: 0,
  })) });
  vi.spyOn(embed, 'rerankDocuments').mockResolvedValue([{ index: 0, score: 0.95 }]);
  const local = new LexicalIndex();
  vi.spyOn(bm25, 'searchBm25').mockImplementation(req => local.search(req));
  clearRecallInjection(); inject.mockClear();
});
afterEach(() => { Object.assign(settings.apiSettings.vector, JSON.parse(JSON.stringify(original))); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('真实 BM25 候选 A 升原文，独立榜 B/C 补齐，D 向量补位；原始 User 精确词保留', async () => {
  await runVectorRecall();
  expect(embed.rerankDocuments).toHaveBeenCalledWith('回忆徽章', ['A 原文'], 1, undefined);
  expect(finalText()).toContain('A 原文'); expect(finalText()).not.toContain('A 摘要');
  for (const id of ['B', 'C', 'D']) expect(finalText()).toContain(`${id} 摘要`);
  expect(finalText()).not.toContain('B 原文'); expect(recallDebug.bm25).toHaveLength(4);
  await runVectorRecall(); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
});

it('BM25 独有候选可以经 rerank 升原文，不要求 embedding 达标', async () => {
  vi.mocked(store.vecSearch).mockResolvedValue({ results: [] });
  await runVectorRecall();
  expect(finalText()).toContain('A 原文'); expect(finalText()).not.toContain('A 摘要');
  expect(finalText()).toContain('B 摘要'); expect(finalText()).toContain('C 摘要');
});

it('rerank 失败保留原生向量回退，BM25 独有项不借分升原文，仍按自身榜补位', async () => {
  settings.apiSettings.vector.recall.fusionCandidates = 5;
  settings.apiSettings.vector.recall.rerankThreshold = 0.8;
  vi.mocked(embed.rerankDocuments).mockRejectedValue(new Error('rerank unavailable'));
  await runVectorRecall();
  expect(finalText()).toContain('A 原文'); expect(finalText()).toContain('B 摘要');
  expect(finalText()).not.toContain('B 原文'); expect(finalText()).toContain('C 摘要');
});

it('关闭 BM25 保留原生向量候选路线；BM25 故障不阻断向量注入', async () => {
  settings.apiSettings.vector.recall.bm25Candidates = 0;
  await runVectorRecall(); expect(bm25.searchBm25).not.toHaveBeenCalled();
  expect(embed.rerankDocuments).toHaveBeenCalledWith('回忆徽章', ['A 原文', 'D 原文'], 2, undefined);
  settings.apiSettings.vector.recall.bm25Candidates = 5;
  vi.mocked(bm25.searchBm25).mockRejectedValue(new Error('worker blocked'));
  await runVectorRecall(); expect(finalText()).toContain('A 原文');
  expect(recallDebug.bm25Status).toContain('失败');
});

it('删除/改摘要使缓存失效并重建候选；重排途中编辑或切聊天不放行旧结果', async () => {
  await runVectorRecall(); expect(finalText()).toContain('B 摘要');
  leaves = leaves.filter(l => l.leafId !== 'B');
  await runVectorRecall(); expect(finalText()).not.toContain('B 摘要'); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
  settings.apiSettings.vector.recall.finalRecallCount = 5;
  vi.mocked(embed.rerankDocuments).mockImplementationOnce(async () => {
    leaves[0].payloadHash = 'edited'; leaves[0].mesFull = '编辑后的原文';
    return [{ index: 0, score: 0.99 }];
  });
  await runVectorRecall(); expect(finalText()).toBe('');
  vi.mocked(bm25.searchBm25).mockImplementationOnce(async () => { chatId = 'B'; return { hits: [], persistent: true }; });
  await runVectorRecall(); expect(finalText()).toBe('');
});
