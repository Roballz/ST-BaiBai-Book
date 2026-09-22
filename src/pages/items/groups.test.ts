import { effectScope, nextTick, ref } from 'vue';
import { expect, it } from 'vitest';
import { useItemGroups } from './groups';
import type { MemItem } from '@/memory/types';

it('模式更新不移动条目，刷新后重新分组；新增删除及切聊天同步', async () => {
  const scope = effectScope();
  const items = ref<MemItem[]>([
    { id: 'a', name: 'A', important: true, createdAt: 0, updatedAt: 0 },
    { id: 'b', name: 'B', createdAt: 0, updatedAt: 0 },
    { id: 'c', name: 'C', hidden: true, createdAt: 0, updatedAt: 0 },
  ]);
  const chat = ref('one');
  const state = scope.run(() => useItemGroups(() => items.value, () => chat.value))!;
  const ids = () => state.groups.value.map(group => group.items.map(item => item.id));
  expect(ids()).toEqual([['a'], ['b'], ['c']]);
  // Replaying stored deltas replaces objects, so retaining object identity is insufficient.
  items.value = items.value.map(item => item.id === 'b' ? { ...item, important: true, desc: '新描述' } : item);
  await nextTick();
  expect(ids()).toEqual([['a'], ['b'], ['c']]);
  expect(state.groups.value[1].items[0]).toMatchObject({ important: true, desc: '新描述' });
  expect(state.pending.value).toBe(true);
  state.refresh();
  expect(ids()).toEqual([['a', 'b'], [], ['c']]);
  expect(state.pending.value).toBe(false);
  items.value[0].hidden = true;
  items.value.push({ id: 'd', name: 'D', createdAt: 0, updatedAt: 0 });
  items.value = items.value.filter(item => item.id !== 'c');
  await nextTick();
  expect(ids()).toEqual([['a', 'b'], ['d'], []]);
  state.refresh();
  expect(ids()).toEqual([['b'], ['d'], ['a']]);
  items.value[1].important = false;
  chat.value = 'two';
  await nextTick();
  expect(ids()).toEqual([[], ['b', 'd'], ['a']]);
  scope.stop();
});
