import type { ItemDelta, ItemFields } from './types';

/** Optional fields keep old archives readable. History additions never replace prior provenance. */
export function applyItemFields(item: ItemFields, delta: ItemDelta): void {
  if (Array.isArray(delta.keywords)) item.keywords = [...new Set(delta.keywords.map(k => k.trim()).filter(Boolean))];
  if (typeof delta.holder === 'string') item.holder = delta.holder.trim();
  if (typeof delta.history === 'string') item.history = delta.history.trim();
  if (delta.historyAppend?.trim()) {
    const additions = delta.historyAppend.split('\n').map(s => s.trim()).filter(Boolean);
    const lines = (item.history || '').split('\n').filter(Boolean);
    for (const line of additions) if (!lines.includes(line)) lines.push(line);
    item.history = lines.join('\n');
  }
  if (typeof delta.important === 'boolean') {
    item.important = delta.important;
    if (delta.important) item.hidden = false;
  }
  if (typeof delta.hidden === 'boolean') {
    item.hidden = delta.hidden;
    if (delta.hidden) item.important = false;
  }
}

/** Same case-sensitive, any-keyword substring matching as life details. Hidden wins conflicts. */
export function itemInjectionMode(item: ItemFields, context: string): 'hidden' | 'full' | 'default' {
  const hit = item.keywords?.some(k => k.trim() && context.includes(k.trim()));
  if (item.hidden) return hit ? 'full' : 'hidden';
  return item.important || hit ? 'full' : 'default';
}
