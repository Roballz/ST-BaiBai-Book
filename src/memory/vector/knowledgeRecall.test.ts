import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as engine from '../engine';
import * as index from './index';
import * as scope from './scope';
import * as store from './store';
import * as embed from './embed';
import * as rewrite from './rewrite';
import * as knowledge from './knowledge';
import { clearRecallInjection, runVectorRecall } from './recall';

const original = JSON.parse(JSON.stringify(settings.apiSettings.vector));
const originalAutoHide = settings.apiSettings.autoHideEnabled;
let database: string;
let chatId: string;
let inject: ReturnType<typeof vi.fn>;
let file: knowledge.KnowledgeFile;
beforeEach(async () => {
  database = `recall-${crypto.randomUUID()}`; chatId = 'chat-A'; inject = vi.fn();
  const cache = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => cache.get(k) ?? null,
    setItem: (k: string, v: string) => cache.set(k, v), removeItem: (k: string) => cache.delete(k) });
  settings.apiSettings.vector.enabled = true;
  settings.apiSettings.vector.knowledge = { enabled: true, count: 1, threshold: 0.8, maxChars: 2000 };
  Object.assign(settings.apiSettings.vector.embedding, { url: 'https://example.test', model: 'test' });
  Object.assign(settings.apiSettings.vector.recall, { minAiFloors: 0, finalRecallCount: 1, fullTextCount: 0, embeddingThreshold: 0.8 });
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(scope, 'currentVectorDb').mockImplementation(() => database);
  vi.spyOn(scope, 'currentChatId').mockImplementation(() => chatId);
  vi.spyOn(scope, 'currentChatScope').mockImplementation(() => `chat:${chatId}`);
  vi.spyOn(scope, 'recallScopes').mockImplementation(() => [`chat:${chatId}`]);
  vi.spyOn(scope, 'currentBundleHashes').mockReturnValue([]);
  const chat = [{ is_user: false, mes: 'earlier' }, { is_user: true, mes: '问BB' }] as STMessage[];
  vi.spyOn(context, 'getContext').mockReturnValue({ chat, setExtensionPrompt: inject } as unknown as STContext);
  vi.spyOn(engine, 'resolveKeepStart').mockReturnValue(1);
  vi.spyOn(index, 'ensureRecallIndex').mockResolvedValue(undefined);
  vi.spyOn(embed, 'embedTexts').mockImplementation(async texts => texts.map(() => new Float32Array([0, 1])));
  vi.spyOn(embed, 'rerankDocuments').mockResolvedValue([{ index: 0, score: 0.95 }]);
  vi.spyOn(rewrite, 'rewriteQuery').mockResolvedValue({ intent: 'BB', queries: ['BB'] });
  vi.spyOn(store, 'vecSearch').mockResolvedValue({ results: [{ leafId: 'old-leaf', scope: 'chat:chat-A',
    similarity: 0.95, queryIndex: 0, document: '旧剧情摘要', mesFull: '旧全文', storyTime: null, msgIndex: 0 }] });
  file = await knowledge.importKnowledge(database, '设定.md', '===', ['BB设定']);
  vi.mocked(embed.embedTexts).mockClear();
  clearRecallInjection(); inject.mockClear();
});
afterEach(() => { Object.assign(settings.apiSettings.vector, original); settings.apiSettings.autoHideEnabled = originalAutoHide; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const finalText = () => String(inject.mock.calls.at(-1)?.[1] ?? '');

it('自动隐藏关闭后排除窗口外仍显示原文的叶子，切换开关失效旧缓存', async () => {
  const chat = context.getContext()!.chat;
  chat[0].extra = { bbs_leaf: { id: 'visible-old', text: 'visible summary', delta: {}, createdAt: 1, swipe: 0, v: 1 } };
  settings.apiSettings.autoHideEnabled = true;
  await runVectorRecall();
  expect(store.vecSearch).toHaveBeenLastCalledWith(database, expect.anything(), expect.anything(), expect.objectContaining({ excludeLeafIds: [] }));
  settings.apiSettings.autoHideEnabled = false;
  await runVectorRecall();
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
  expect(store.vecSearch).toHaveBeenLastCalledWith(database, expect.anything(), expect.anything(), expect.objectContaining({ excludeLeafIds: ['visible-old'] }));
});

it('摘要与知识库共享一次 query/embedding，独立额度并按摘要后顺序注入；再次运行命中缓存', async () => {
  await runVectorRecall();
  expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
  expect(embed.embedTexts).toHaveBeenCalledTimes(1);
  expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).toContain('BB设定');
  expect(finalText().indexOf('【额外信息】')).toBeGreaterThan(finalText().indexOf('旧剧情摘要'));
  const text = finalText(); await runVectorRecall();
  expect(finalText()).toBe(text); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
  settings.apiSettings.vector.knowledge.threshold = 1;
  await runVectorRecall(); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(2);
});

it('无窗口外摘要的新聊天仍召回知识库，不补建摘要索引', async () => {
  vi.mocked(engine.resolveKeepStart).mockReturnValue(0);
  await runVectorRecall();
  expect(index.ensureRecallIndex).not.toHaveBeenCalled(); expect(store.vecSearch).not.toHaveBeenCalled();
  expect(finalText()).toContain('BB设定'); expect(rewrite.rewriteQuery).toHaveBeenCalledTimes(1);
});

it('摘要没有候选也不跳过知识库；知识库阈值不改变摘要额度', async () => {
  vi.mocked(store.vecSearch).mockResolvedValueOnce({ results: [] });
  await runVectorRecall(); expect(finalText()).toContain('BB设定');
  await knowledge.setKnowledgeEnabled(file, false);
  await runVectorRecall(); expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).not.toContain('BB设定');
});

it('召回中切聊天或取消，不把旧结果注入新聊天', async () => {
  vi.mocked(rewrite.rewriteQuery).mockImplementationOnce(async () => {
    chatId = 'chat-B'; return { intent: 'BB', queries: ['BB'] };
  });
  await runVectorRecall(); expect(inject.mock.calls.every(call => call[1] === '')).toBe(true);
  const signal = new AbortController();
  vi.mocked(rewrite.rewriteQuery).mockImplementationOnce(async () => {
    signal.abort(); return { intent: 'BB', queries: ['BB'] };
  });
  await runVectorRecall(signal.signal); expect(finalText()).toBe('');
});

it('召回中知识库被删除，丢弃旧命中，缓存不复用', async () => {
  vi.mocked(rewrite.rewriteQuery).mockImplementationOnce(async () => {
    await knowledge.deleteKnowledge(file); return { intent: 'BB', queries: ['BB'] };
  });
  await runVectorRecall(); expect(finalText()).toBe('');
  await runVectorRecall(); expect(finalText()).toContain('旧剧情摘要'); expect(finalText()).not.toContain('BB设定');
});

it('知识库读取失败不阻断摘要召回', async () => {
  vi.spyOn(knowledge, 'listKnowledge').mockRejectedValue(new Error('storage unavailable'));
  await runVectorRecall(); expect(finalText()).toContain('旧剧情摘要');
});
