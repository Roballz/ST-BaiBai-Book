import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { apiSettings } from '@/api/settings';
import { appendOpToLatestLeaf, deriveMemory, editItem, finalizeDelta } from './apply';
import { createNewChatWithCarryover } from './carryover';
import * as inject from './inject';
import { itemInjectionMode } from './items';
import { buildSummaryPrompt } from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type StoredDelta } from './types';

const original = { injection: { ...apiSettings.injection }, summaryOnly: apiSettings.summaryOnlyMode,
  keepRecent: apiSettings.keepRecent, prompt: apiSettings.prompts.summary };
let seq = 0;
function message(delta: StoredDelta = {}, mes = '正在交谈'): STMessage {
  return { name: '艾琳', is_user: false, is_system: false, mes,
    extra: { bbs_leaf: { id: `items-${++seq}`, text: '交谈', delta, createdAt: seq, swipe: 0, v: 1 } } };
}
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '林舟', name2: '艾琳',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'items-test' } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const item = { name: '古剑', desc: '蓝色剑身', keywords: ['剑鞘', '信物'], holder: '艾琳', history: '铸于北城',
  carried: false, location: '北城宝库', qty: 1 };
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  apiSettings.summaryOnlyMode = false;
  Object.assign(apiSettings.injection, { items: true, scenes: true });
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
  Object.assign(apiSettings.injection, original.injection);
  apiSettings.summaryOnlyMode = original.summaryOnly;
  apiSettings.keepRecent = original.keepRecent;
  apiSettings.prompts.summary = original.prompt;
});

it('字段通过 AI 清洗、重放、序列化；转移追加历史并保留旧起源', () => {
  const chat = [message(finalizeDelta({ items: { add: [item] } }, [])),
    message(finalizeDelta({ items: { update: [{ name: item.name, holder: '林舟', historyAppend: '艾琳赠予林舟' }] } }, []))];
  const result = deriveMemory(JSON.parse(JSON.stringify(chat))).items[0];
  expect(result).toMatchObject({ ...item, holder: '林舟', history: '铸于北城\n艾琳赠予林舟' });
  expect(deriveMemory(chat, 1).items[0].holder).toBe('艾琳');
  expect(deriveMemory(chat).items).toEqual([result]);
  const ai = finalizeDelta({ items: { update: [{ name: item.name, hidden: true, important: true, history: '新来源' }] } }, []);
  expect(ai.items!.update![0]).not.toHaveProperty('hidden');
  expect(ai.items!.update![0]).not.toHaveProperty('important');
  expect(deriveMemory([...chat, message(ai)]).items[0].history).toBe('铸于北城\n艾琳赠予林舟\n新来源');
  const more = finalizeDelta({ items: { add: [{ name: item.name, history: '后来修复于南城' }] } }, []);
  expect(deriveMemory([...chat, message(more)]).items[0].history).toBe('铸于北城\n艾琳赠予林舟\n后来修复于南城');
  expect(deriveMemory([message({ items: { add: [{ name: '旧物品' }] } })]).items[0].keywords).toBeUndefined();
});

it('手动清空、改名与模式切换写入叶子，重载后不丢失', () => {
  const ctx = useChat([message({ items: { add: [{ ...item, important: true }] } })]);
  expect(editItem('古剑', { name: '旧剑', qty: 1, holder: '', keywords: [], history: '' })).toBe(true);
  expect(memory.items[0]).toMatchObject({ name: '旧剑', holder: '', keywords: [], history: '', important: true });
  appendOpToLatestLeaf({ items: { update: [{ name: '旧剑', hidden: true }] } });
  expect(deriveMemory(JSON.parse(JSON.stringify(ctx.chat))).items[0]).toMatchObject({ hidden: true, important: false, history: '' });
  appendOpToLatestLeaf({ items: { update: [{ name: '旧剑', important: true }] } });
  expect(memory.items[0]).toMatchObject({ hidden: false, important: true });
});

it('实际状态注入：普通寄存简表、星标全量、隐藏零信息、任一关键词展开', () => {
  const ctx = useChat([message({ items: { add: [item] } })]);
  expect(inject.buildStateInjectionText()).toContain('古剑');
  expect(inject.buildStateInjectionText()).not.toContain('蓝色剑身');
  appendOpToLatestLeaf({ items: { update: [{ name: item.name, important: true }] } });
  for (const text of ['蓝色剑身', '持有人:艾琳', '历史起源:铸于北城', '关键词:剑鞘、信物']) {
    expect(inject.buildStateInjectionText()).toContain(text);
  }
  appendOpToLatestLeaf({ items: { update: [{ name: item.name, hidden: true }] } });
  expect(inject.buildStateInjectionText()).not.toContain('古剑');
  ctx.chat.push({ ...message({}, '请看看信物'), is_user: true });
  expect(inject.buildStateInjectionText()).toContain('蓝色剑身');
  expect(inject.buildStateInjectionText()).toContain('铸于北城');
  apiSettings.injection.items = false;
  expect(inject.buildStateInjectionText()).not.toContain('古剑');
  expect(itemInjectionMode({ hidden: true, important: true, keywords: ['  '] }, '正文')).toBe('hidden');
  expect(itemInjectionMode({ keywords: ['A', 'B'] }, 'B')).toBe('full');
  expect(itemInjectionMode({ keywords: ['A'] }, 'a')).toBe('default');
});

it('跨聊天继承的种子保留新增字段和隐藏模式', async () => {
  apiSettings.keepRecent = 1;
  const source = useChat([message({ items: { add: [{ ...item, hidden: true }] } }), message(), message()]);
  const before = JSON.stringify(source.chat);
  const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'items-carried' };
  vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
  vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
  expect(await createNewChatWithCarryover()).toBe(true);
  expect(deriveMemory(target.chat).items[0]).toMatchObject({ ...item, hidden: true });
  expect(JSON.stringify(source.chat)).toBe(before);
});

it('默认和旧自定义摘要模板均包含字段协议', () => {
  const args = { user: '林舟', char: '艾琳', time: '', location: '', protagonist: {}, sceneFocus: null,
    lifeDetails: [], items: [item], itemLog: [], scenes: [], npcs: [], openPlans: [], resolvedPlans: [],
    history: '', content: '交谈', hasTimeTags: false, varsState: {}, varsMeaning: '', varsRule: '' };
  for (const template of ['', '{{content}}']) {
    apiSettings.prompts.summary = template;
    const prompt = buildSummaryPrompt(args);
    expect(prompt.system + prompt.user).toContain('historyAppend');
    expect(prompt.system + prompt.user).toContain('keywords');
    expect(prompt.system + prompt.user).toContain('holder');
  }
});
