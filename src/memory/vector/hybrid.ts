import type { VecHit } from '@/api/baibaoku';

/** 分数各自保留，BM25 独有命中没有余弦分，不能冒充 embedding 或 rerank。 */
export interface HybridHit extends Omit<VecHit, 'similarity'> {
  similarity: number | null;
  bm25Score?: number;
  rrfScore?: number;
}
export interface RankedHit extends HybridHit { rerankScore: number | null; rerankFallback?: boolean }
export interface HybridLimits {
  rerankCandidates: number;
  bm25Candidates: number;
  fusionCandidates: number;
  bm25Count: number;
  rrfCount: number;
  fullTextCount: number;
  finalRecallCount: number;
  embeddingThreshold: number;
  rerankThreshold: number;
}
export function boundedCount(value: number, fallback: number, max = 200): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
}
export function normalizeHybridLimits<T extends HybridLimits>(cfg: T): T {
  return { ...cfg, rerankCandidates: boundedCount(cfg.rerankCandidates, 20),
    bm25Candidates: boundedCount(cfg.bm25Candidates, 0),
    fusionCandidates: boundedCount(cfg.fusionCandidates, cfg.rerankCandidates || 20),
    bm25Count: boundedCount(cfg.bm25Count, 2), rrfCount: boundedCount(cfg.rrfCount, 0), fullTextCount: boundedCount(cfg.fullTextCount, 2),
    finalRecallCount: boundedCount(cfg.finalRecallCount, 5) };
}

/** 同一 scope 的同一切片才合并分数；不同快照的同名叶子不可混合原文。 */
export const candidateKey = (hit: Pick<HybridHit, 'scope' | 'leafId'>): string => JSON.stringify([hit.scope, hit.leafId]);

/** 向量多 Query 已在存储层 max 融合，这里只融合向量/BM25 两张榜，k 固定 60。 */
export function fuseCandidates(vector: HybridHit[], lexical: HybridHit[], limit: number): HybridHit[] {
  const merged = new Map<string, HybridHit>();
  for (const list of [vector, lexical]) {
    const seen = new Set<string>();
    let rank = 0;
    for (const hit of list) {
      const key = candidateKey(hit);
      if (seen.has(key)) continue;
      seen.add(key);
      const previous = merged.get(key);
      const score = 1 / (60 + ++rank);
      merged.set(key, previous
        ? { ...previous, bm25Score: hit.bm25Score ?? previous.bm25Score, rrfScore: (previous.rrfScore || 0) + score }
        : { ...hit, rrfScore: score });
    }
  }
  return [...merged.values()].sort((a, b) => b.rrfScore! - a.rrfScore!).slice(0, limit);
}

export interface SelectedHit { hit: HybridHit; tier: 'full' | 'brief'; route: 'full' | 'bm25' | 'rrf' | 'vector' }
/** 正文 → BM25 → RRF → 向量；独立榜顺延补位，共享已选身份集合和总额度。 */
export function selectRecall(
  ranked: RankedHit[], lexical: HybridHit[], vector: HybridHit[], limits: HybridLimits,
  fused: HybridHit[] = [],
): SelectedHit[] {
  const cfg = normalizeHybridLimits(limits);
  const selected: SelectedHit[] = [];
  const seen = new Set<string>();
  const pick = (list: HybridHit[], count: number, tier: 'full' | 'brief', route: SelectedHit['route']) => {
    let used = 0;
    for (const hit of list) {
      if (used >= count || selected.length >= cfg.finalRecallCount) break;
      if (seen.has(hit.leafId) || !(tier === 'full' ? hit.mesFull || hit.document : hit.document)?.trim()) continue;
      seen.add(hit.leafId); selected.push({ hit, tier, route }); used++;
    }
  };
  pick(ranked.filter(h => h.rerankScore !== null && h.rerankScore >= cfg.rerankThreshold), cfg.fullTextCount, 'full', 'full');
  pick(lexical, cfg.bm25Count, 'brief', 'bm25');
  pick(fused, cfg.rrfCount, 'brief', 'rrf');
  pick(vector.filter(h => h.similarity !== null && h.similarity >= cfg.embeddingThreshold), cfg.finalRecallCount, 'brief', 'vector');
  return selected;
}
