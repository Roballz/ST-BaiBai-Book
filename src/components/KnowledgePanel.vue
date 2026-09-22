<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { apiSettings } from '@/api/settings';
import { currentVectorDb } from '@/memory/vector/scope';
import { clearRecallInjection } from '@/memory/vector/recall';
import { invalidateRecallCache } from '@/memory/vector/cache';
import { deleteKnowledge, embeddingIdentity, importKnowledge, knowledgeDebug, listKnowledge,
  readKnowledgeFile, setKnowledgeEnabled, type KnowledgeFile } from '@/memory/vector/knowledge';

const files = ref<KnowledgeFile[]>([]);
const delimiter = ref('=========');
const encoding = ref('utf-8');
const preview = ref<{ name: string; database: string; delimiter: string; chunks: string[] } | null>(null);
const busy = ref(false);
const status = ref('');
const selectedBlock = ref(0);
let controller: AbortController | undefined;
function changed() { invalidateRecallCache(); clearRecallInjection(); }
async function refresh() {
  const database = currentVectorDb();
  files.value = [];
  if (!database) { status.value = '请先进入单角色聊天'; return; }
  try {
    const result = await listKnowledge(database);
    if (database === currentVectorDb()) files.value = result;
  } catch (error) { status.value = String(error); }
}
async function choose(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  preview.value = null;
  if (!file) return;
  const database = currentVectorDb();
  if (!database) { status.value = '请先进入单角色聊天'; return; }
  busy.value = true;
  try {
    const marker = delimiter.value;
    const chunks = await readKnowledgeFile(file, marker, encoding.value);
    if (database !== currentVectorDb()) throw new Error('角色已切换，请重新选择文件');
    preview.value = { name: file.name, database, delimiter: marker, chunks };
    selectedBlock.value = 0;
    status.value = `已解析 ${chunks.length} 块，尚未发送或向量化`;
  } catch (error) { status.value = `读取失败：${String(error)}；乱码时可切换编码后重新选文件`; }
  finally { busy.value = false; }
}
async function commit() {
  const prepared = preview.value;
  if (!prepared || busy.value) return;
  if (prepared.database !== currentVectorDb()) { status.value = '角色已切换，请重新选择文件'; preview.value = null; return; }
  busy.value = true;
  controller = new AbortController();
  try {
    await importKnowledge(prepared.database, prepared.name, prepared.delimiter, prepared.chunks, controller.signal,
      done => { status.value = `已向量化 ${done}/${prepared.chunks.length} 块`; });
    preview.value = null;
    changed();
    status.value = '导入完成，已保存到所选角色的本机知识库';
  } catch (error) { status.value = `未发布此次导入：${String(error)}`; }
  finally { busy.value = false; controller = undefined; await refresh(); }
}
async function update(file: KnowledgeFile, remove = false) {
  if (busy.value) return;
  if (file.database !== currentVectorDb()) { await refresh(); status.value = '角色已切换，请重新操作'; return; }
  if (remove && !window.confirm(`删除知识库文件“${file.name}”及其向量？`)) return;
  busy.value = true;
  try {
    if (remove) await deleteKnowledge(file); else await setKnowledgeEnabled(file, !file.enabled);
    changed();
    status.value = remove ? '文件及向量已删除' : '文件启用状态已更新';
  } catch (error) { status.value = String(error); }
  finally { busy.value = false; await refresh(); }
}
function download(file: KnowledgeFile) {
  const url = URL.createObjectURL(new Blob([file.chunks.join(`\n${file.delimiter}\n`)], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = file.name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
onMounted(refresh);
onBeforeUnmount(() => controller?.abort());
</script>

<template>
  <section class="bbs-knowledge">
    <h4>额外知识库（TXT / MD）</h4>
    <p>按当前角色隔离，保存在本机浏览器；同角色各聊天可用，不自动同步到其他设备。切换角色后点击刷新。</p>
    <label><input v-model="apiSettings.vector.knowledge.enabled" type="checkbox" @change="changed" />启用知识库召回（同时需开启向量记忆）</label>
    <div class="kb-fields">
      <label>独立召回块数<input v-model.number="apiSettings.vector.knowledge.count" class="bbs-input" type="number" min="0" max="30" @change="changed" /></label>
      <label>相似度阈值<input v-model.number="apiSettings.vector.knowledge.threshold" class="bbs-input" type="number" min="0" max="1" step="0.01" @change="changed" /></label>
      <label>内容预算（字符）<input v-model.number="apiSettings.vector.knowledge.maxChars" class="bbs-input" type="number" min="0" max="100000" @change="changed" /></label>
    </div>
    <p>与摘要共用一次 query 改写和 query 向量；按向量相似度筛选完整区块，不占摘要/原文条数。超过预算的区块跳过，不截断、不拼接相邻块。结果置于召回摘要下方的【额外信息】。</p>
    <div class="kb-fields">
      <label>独占一行的分隔符<input v-model="delimiter" class="bbs-input" :disabled="busy" /></label>
      <label>文件编码<select v-model="encoding" class="bbs-input" :disabled="busy"><option value="utf-8">UTF-8</option><option value="gb18030">GB18030 / GBK</option><option value="utf-16le">UTF-16 LE</option><option value="utf-16be">UTF-16 BE</option></select></label>
    </div>
    <p>每文件最多 5 MB / 1000 块，每块最多 24000 字符。先设置分隔符和编码，再选文件；Markdown 按原文保留。</p>
    <input type="file" accept=".txt,.md" :disabled="busy" aria-label="选择知识库文件" @change="choose" />
    <div v-if="preview" class="kb-preview">
      <p>{{ preview.name }} · {{ preview.chunks.length }} 个独立区块</p>
      <label>预览第几块<input v-model.number="selectedBlock" class="bbs-input" type="range" min="0" :max="preview.chunks.length - 1" /></label>
      <pre>{{ preview.chunks[selectedBlock] }}</pre>
      <p>点击确认后，文件各区块将发送至已配置的 Embedding 服务进行向量化。</p>
      <button class="bbs-btn bbs-btn-primary" :disabled="busy" @click="commit">确认导入并向量化</button>
      <button v-if="busy" class="bbs-btn" @click="controller?.abort()">取消导入</button>
    </div>
    <p role="status">{{ status }}</p>
    <button class="bbs-btn" :disabled="busy" @click="refresh">刷新当前角色文件</button>
    <div v-for="file in files" :key="file.id" class="kb-file">
      <strong>{{ file.name }}</strong><span>{{ file.chunks.length }} 块 · {{ file.enabled ? '启用' : '停用' }}</span>
      <span v-if="file.embedding !== embeddingIdentity()">Embedding 配置已变，本文件暂停召回；请导出后重新导入。</span>
      <div><button class="bbs-btn" :disabled="busy" @click="update(file)">{{ file.enabled ? '停用' : '启用' }}</button>
        <button class="bbs-btn" @click="download(file)">导出文本</button>
        <button class="bbs-btn" :disabled="busy" @click="update(file, true)">删除</button></div>
    </div>
    <p>{{ knowledgeDebug.status }}</p>
    <p v-for="hit in knowledgeDebug.hits" :key="`${hit.name}:${hit.block}`">{{ hit.name }} · 第{{ hit.block }}块 · {{ hit.score.toFixed(3) }}</p>
  </section>
</template>

<style scoped>
.bbs-knowledge { display: grid; gap: 10px; margin: 16px 0; }
.bbs-knowledge p { font-size: 12px; color: var(--bbs-ink-muted); margin: 0; }
.kb-fields { display: flex; flex-wrap: wrap; gap: 10px; }
.kb-fields label { flex: 1; min-width: 130px; }
.kb-preview pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; padding: 10px; background: var(--bbs-surface-2); }
.kb-file { display: grid; gap: 6px; border: 1px solid var(--bbs-line); padding: 10px; border-radius: 8px; overflow-wrap: anywhere; }
</style>
