import 'fake-indexeddb/auto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import { apiSettings } from '@/api/settings';
import * as embed from './embed';
import { localStore } from './store';
import { deleteKnowledge, embeddingIdentity, eligibleKnowledge, importKnowledge, knowledgeFingerprint,
  knowledgeScope, listKnowledge, readKnowledgeFile, recallKnowledge, setKnowledgeEnabled, splitKnowledge } from './knowledge';

const original = structuredClone(JSON.parse(JSON.stringify(apiSettings.vector)));
const config = { enabled: true, count: 3, threshold: 0.8, maxChars: 6000 };
let database: string;
beforeEach(() => {
  database = `test-${crypto.randomUUID()}`;
  Object.assign(apiSettings.vector.embedding, { url: 'https://example.test', model: 'synthetic', key: '' });
  vi.spyOn(embed, 'embedTexts').mockImplementation(async texts => texts.map(text => text.includes('BB')
    ? new Float32Array([0, 1]) : new Float32Array([1, 0])));
});
afterEach(() => { Object.assign(apiSettings.vector, original); vi.restoreAllMocks(); });

it('只按完整分隔行切分，不把行内等号或 Markdown 正文拆开；跳过空块', () => {
  expect(splitKnowledge('\uFEFF设定AA\r\n=========\r\n\r\n=========\r\n# 设定BB\n行内=========保留', '=========')).toEqual(['设定AA', '# 设定BB\n行内=========保留']);
  expect(splitKnowledge('AA\n.*\nBB', '.*')).toEqual(['AA', 'BB']);
  expect(() => splitKnowledge('AA', '')).toThrow();
  expect(() => splitKnowledge('a'.repeat(24001), '===')).toThrow('24000');
});

it('TXT/MD 编码读取，拒绝超限及不支持格式', async () => {
  expect(await readKnowledgeFile(new File(['AA\n===\nBB'], '设定.MD'), '===')).toEqual(['AA', 'BB']);
  expect(await readKnowledgeFile(new File([new Uint8Array([0xff, 0xfe, 65, 0])], 'a.txt'), '===', 'utf-16le')).toEqual(['A']);
  await expect(readKnowledgeFile(new File(['doc'], 'a.doc'), '===')).rejects.toThrow('TXT');
  await expect(readKnowledgeFile(new File([new Uint8Array([0xff])], 'a.txt'), '===')).rejects.toThrow();
});

it('真实本地向量检索只返回 BB，不连带 AA；重读持久化、角色隔离、停用和删除', async () => {
  const file = await importKnowledge(database, '设定.txt', '=========', ['设定AA', '设定BB']);
  const reloaded = await listKnowledge(database);
  expect(reloaded).toEqual([file]);
  expect(await listKnowledge(`${database}-other`)).toEqual([]);
  const query = [embed.encodeFloat32Base64(new Float32Array([0, 1]))];
  const text = await recallKnowledge(database, reloaded, query, config);
  expect(text).toContain('设定BB'); expect(text).not.toContain('设定AA');
  expect(text).toContain('第2块');
  expect(await recallKnowledge(database, reloaded, query, { ...config, maxChars: 2 })).toBe('');
  expect(await recallKnowledge(database, reloaded, query, { ...config, count: 0 })).toBe('');
  await setKnowledgeEnabled(reactive(file), false);
  expect(knowledgeFingerprint(await listKnowledge(database))).not.toBe(knowledgeFingerprint(reloaded));
  expect(await recallKnowledge(database, await listKnowledge(database), query, config)).toBe('');
  await deleteKnowledge((await listKnowledge(database))[0]);
  expect(await listKnowledge(database)).toEqual([]);
  expect((await localStore.stats(database, [knowledgeScope(file)])).stats[knowledgeScope(file)]).toBe(0);
});

it('跨批次失败和取消不发布半成品，也不影响已导入的文件', async () => {
  const good = await importKnowledge(database, 'good.txt', '===', ['AA']);
  vi.mocked(embed.embedTexts).mockResolvedValueOnce(Array.from({ length: 16 }, () => new Float32Array([1, 0])))
    .mockRejectedValueOnce(new Error('service failed'));
  await expect(importKnowledge(database, 'bad.txt', '===', Array(17).fill('BB'))).rejects.toThrow('service failed');
  expect(await listKnowledge(database)).toEqual([good]);
  const abort = new AbortController();
  await expect(importKnowledge(database, 'cancel.txt', '===', ['BB'], abort.signal, () => abort.abort())).rejects.toThrow();
  expect(await listKnowledge(database)).toEqual([good]);
});

it('模型切换后禁用不兼容向量，导入中途切换不发布', async () => {
  const file = await importKnowledge(database, 'old.md', '===', ['AA']);
  apiSettings.vector.embedding.model = 'new';
  expect(embeddingIdentity()).not.toBe(file.embedding);
  expect(eligibleKnowledge([file], config)).toEqual([]);
  await expect(importKnowledge(database, 'changed.md', '===', ['BB'], undefined,
    () => { apiSettings.vector.embedding.model = 'another'; })).rejects.toThrow('配置已改变');
  expect(await listKnowledge(database)).toEqual([file]);
});
