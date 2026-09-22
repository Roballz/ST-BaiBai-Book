import { computed, ref, watch } from 'vue';
import type { MemItem } from '@/memory/types';

type Group = 'important' | 'secondary' | 'hidden';
const mode = (item: MemItem): Group => item.hidden ? 'hidden' : item.important ? 'important' : 'secondary';

/** Freeze group membership, not item data: buttons/content stay live until explicit regrouping. */
export function useItemGroups(items: () => MemItem[], scope: () => string) {
  const membership = ref(new Map<string, Group>());
  let activeScope: string | undefined;
  watch(() => [scope(), items().map(item => [item.id, item.important, item.hidden])] as const, ([current]) => {
    const next = current === activeScope ? new Map(membership.value) : new Map<string, Group>();
    const ids = new Set(items().map(item => item.id));
    for (const id of next.keys()) if (!ids.has(id)) next.delete(id);
    for (const item of items()) if (!next.has(item.id)) next.set(item.id, mode(item));
    activeScope = current;
    membership.value = next;
  }, { immediate: true });
  const groups = computed(() => ([
    { id: 'important', title: '重要物品' },
    { id: 'secondary', title: '次要物品' },
    { id: 'hidden', title: '隐藏物品' },
  ] as const).map(group => ({ ...group, items: items().filter(item => (membership.value.get(item.id) ?? mode(item)) === group.id) })));
  const pending = computed(() => items().some(item => membership.value.has(item.id) && membership.value.get(item.id) !== mode(item)));
  function refresh() { membership.value = new Map(items().map(item => [item.id, mode(item)])); }
  return { groups, pending, refresh };
}
