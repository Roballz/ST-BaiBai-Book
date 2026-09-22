import { expect, it } from 'vitest';
import { fuseCandidates, normalizeHybridLimits, selectRecall, type HybridHit, type RankedHit } from './hybrid';

const config = { rerankCandidates: 20, bm25Candidates: 20, fusionCandidates: 20, bm25Count: 2, rrfCount: 0,
  fullTextCount: 2, finalRecallCount: 6, embeddingThreshold: 0.8, rerankThreshold: 0.9 };
const hit = (id: string, similarity: number | null = 0.85): HybridHit => ({ leafId: id, scope: 'chat:A',
  document: `摘要 ${id}`, mesFull: `原文 ${id}`, storyTime: null, msgIndex: 1, queryIndex: 0, similarity });
const ranked = (ids: string[]): RankedHit[] => ids.map(id => ({ ...hit(id), rerankScore: 0.95 }));
const lexical = (ids: string[]) => ids.map((id, i) => ({ ...hit(id, null), bm25Score: 10 - i }));

it('RRF 摘要跳过原文与 BM25 后顺延，低向量分可补入且共享总额', () => {
  const fused = ['A', 'B', 'C', 'D', 'E'].map(id => hit(id, 0.1));
  const selected = selectRecall(ranked(['A']), lexical(['B']), [hit('V')],
    { ...config, rrfCount: 2, finalRecallCount: 5 }, fused);
  expect(selected.map(s => [s.hit.leafId, s.route])).toEqual([
    ['A', 'full'], ['B', 'bm25'], ['C', 'rrf'], ['D', 'rrf'], ['V', 'vector'],
  ]);
  expect(selectRecall(ranked(['A']), lexical(['B']), [],
    { ...config, rrfCount: 20, finalRecallCount: 2 }, fused)).toHaveLength(2);
  expect(selectRecall([], [], [hit('V')], config, fused).map(s => s.hit.leafId)).toEqual(['V']);
  expect(normalizeHybridLimits({ ...config, rrfCount: NaN }).rrfCount).toBe(0);
});

it('原文只受 rerank 门槛及额度限制，不要求 embedding 达标', () => {
  const selected = selectRecall([{ ...hit('A', 0.1), rerankScore: 0.95 }], [], [], config);
  expect(selected.map(s => s.route)).toEqual(['full']);
});

it('去重 RRF 让双路命中靠前，保留向量分与 BM25 分；不同 scope 不混原文', () => {
  const result = fuseCandidates([hit('A'), hit('B'), hit('B')], lexical(['C', 'B']), 4);
  expect(result.map(h => h.leafId)).toEqual(['B', 'A', 'C']);
  expect(result[0]).toMatchObject({ similarity: 0.85, bm25Score: 9 });
  expect(result[0].rrfScore).toBeCloseTo(2 / 62);
  expect(result[2].similarity).toBeNull();
  const separate = fuseCandidates([hit('A')], [{ ...hit('A', null), scope: 'chat:B', mesFull: '另一原文' }], 4);
  expect(separate).toHaveLength(2); expect(separate[0].mesFull).toBe('原文 A');
});

it('BM25 前两名已升原文，从第三、四名补足，三路合计六条且无重复', () => {
  const selected = selectRecall(ranked(['A', 'B']), lexical(['A', 'B', 'C', 'D']),
    ['A', 'C', 'E', 'F', 'G'].map(id => hit(id)), config);
  expect(selected.map(s => [s.hit.leafId, s.route])).toEqual([
    ['A', 'full'], ['B', 'full'], ['C', 'bm25'], ['D', 'bm25'], ['E', 'vector'], ['F', 'vector'],
  ]);
});

it('没有原文时是两条 BM25 加四条向量；RRF 截断不截掉独立 BM25 补位榜', () => {
  const bm = lexical(['A', 'B', 'C']);
  const v = ['V1', 'V2', 'V3', 'V4', 'V5'].map(id => hit(id));
  const fused = fuseCandidates(v, bm, 1);
  const selected = selectRecall(fused.map(h => ({ ...h, rerankScore: 0.2 })), bm, v, config);
  expect(selected.map(s => s.hit.leafId)).toEqual(['A', 'B', 'V1', 'V2', 'V3', 'V4']);
});

it('BM25 不足由向量补；向量不达阈值不能突破 BM25 上限或强行填满', () => {
  const v = Array.from({ length: 8 }, (_, i) => hit(`V${i}`));
  expect(selectRecall([], lexical(['A']), v, config)).toHaveLength(6);
  const limited = selectRecall([], lexical(['A', 'B', 'C']), [hit('V', 0.2)], config);
  expect(limited.map(s => s.hit.leafId)).toEqual(['A', 'B']);
});

it('零配额、小总额、原文超额和无余弦命中都不绕过名额或分数门槛', () => {
  expect(selectRecall(ranked(['A', 'B']), lexical(['C']), [], { ...config, finalRecallCount: 1 })).toHaveLength(1);
  expect(selectRecall(ranked(['A']), lexical(['B']), [hit('C')], { ...config, finalRecallCount: 0 })).toEqual([]);
  const bm = lexical(['A', 'B']);
  const result = selectRecall(bm.map(h => ({ ...h, rerankScore: null })), bm, [], { ...config, bm25Count: 0 });
  expect(result).toEqual([]);
  expect(normalizeHybridLimits({ ...config, bm25Candidates: -2, fusionCandidates: NaN, bm25Count: 2.9 }))
    .toMatchObject({ bm25Candidates: 0, fusionCandidates: 20, bm25Count: 2 });
});
