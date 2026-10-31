/**
 * 長期記憶路由：/memory 的讀取、搜尋、新增、更新、刪除、重整與匯出，外加 /memory/view 瀏覽器。
 *
 * 只做輸入驗證與轉呼叫；持久化與檢索全在 ../memory/engine。
 * @module dsh-pet/src/host/routes/memory
 */
import { readAllConfig } from '../config.ts';
import { MEMORY_KINDS, type MemoryCandidate, type MemoryKind } from '../memory/types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 記憶相關的 rest 值。 */
const MEMORY_RESTS = new Set(['memory', 'memory/consolidate', 'memory/export', 'memory/view']);

/** 把未知值正規化成記憶種類。 */
function normalizeKind(raw: unknown): MemoryKind {
  const value = typeof raw === 'string' ? raw : 'fact';
  return (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : 'fact';
}

/** 夾在 0–1。 */
function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 記憶領域：未命中回 undefined。 */
export async function handleMemoryRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, url, body } = input;
  if (!MEMORY_RESTS.has(rest)) return undefined;

  // 瀏覽器 HTML：靜態檔由引擎在使用者資料根產生。
  if (rest === 'memory/view') {
    if (method !== 'GET') return methodNotAllowed();
    const file = await deps.memory.ensureView();
    return { kind: 'file', file, contentType: 'text/html; charset=utf-8' };
  }

  let cache: Record<string, Record<string, unknown>> | undefined;
  const cfg = (): Record<string, Record<string, unknown>> => (cache ??= readAllConfig(deps.configPaths));
  const who = deps.requirePet(url.searchParams, cfg, { surface: false });
  if (!who.ok) return who.res;
  const found = { entry: who.entry, conf: who.conf, pet: who.pet };
  const petId = who.petId;

  try {
    if (rest === 'memory/consolidate') {
      if (method !== 'POST') return methodNotAllowed();
      const report = await deps.memory.consolidate(found, petId);
      return okResult({ ok: true, petId, ...report });
    }

    if (rest === 'memory/export') {
      if (method !== 'GET') return methodNotAllowed();
      const data = await deps.memory.exportBucket(found, petId);
      return okResult({ ok: true, ...data }, { 'content-disposition': 'attachment; filename="dsh-pet-memory.json"' });
    }

    if (method === 'GET') {
      const q = url.searchParams.get('q');
      if (q !== null && q.trim() !== '') {
        return okResult({ ok: true, petId, memories: await deps.memory.search(found, petId, q) });
      }
      const data = await deps.memory.list(found, petId);
      return okResult({ ok: true, petId, ...data });
    }

    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return parsed.res;
      const content = typeof parsed.value.content === 'string' ? parsed.value.content.trim() : '';
      if (content === '') return failResult('bad-request', '記憶內容不能為空');
      if (content.length > 500) return failResult('bad-request', '記憶內容過長（上限 500 字）');
      const candidate: MemoryCandidate = {
        kind: normalizeKind(parsed.value.kind),
        content,
        keywords: Array.isArray(parsed.value.keywords)
          ? parsed.value.keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '').slice(0, 8)
          : [],
        importance: clamp01(parsed.value.importance, 0.7),
        confidence: clamp01(parsed.value.confidence, 0.9),
      };
      const memory = await deps.memory.add(found, petId, candidate, parsed.value.pinned === true);
      return okResult({ ok: true, petId, memory });
    }

    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) return parsed.res;
      const id = typeof parsed.value.id === 'string' ? parsed.value.id : '';
      if (id === '') return failResult('bad-request', '缺少記憶 id');
      const patch: { content?: string; importance?: number; pinned?: boolean } = {};
      if (typeof parsed.value.content === 'string') patch.content = parsed.value.content;
      if (parsed.value.importance !== undefined) patch.importance = clamp01(parsed.value.importance, 0.5);
      if (typeof parsed.value.pinned === 'boolean') patch.pinned = parsed.value.pinned;
      const memory = await deps.memory.update(found, petId, id, patch);
      if (!memory) return failResult('unknown-pet', '找不到這條記憶：' + id);
      return okResult({ ok: true, petId, memory });
    }

    if (method === 'DELETE') {
      if (url.searchParams.get('all') === '1') {
        await deps.memory.clear(found, petId);
        return okResult({ ok: true, petId, cleared: true });
      }
      const id = url.searchParams.get('id') ?? '';
      if (id === '') return failResult('bad-request', '缺少 id，或要清空請帶 all=1');
      const removed = await deps.memory.remove(found, petId, id);
      return okResult({ ok: true, petId, removed });
    }

    return methodNotAllowed();
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
}

/** 解析 JSON 請求體。 */
function parseBody(body: string | undefined):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; res: RouteResult } {
  try {
    const parsed = JSON.parse(body ?? 'null') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ok: true, value: parsed as Record<string, unknown> };
    }
  } catch {
    return { ok: false, res: invalidJson() };
  }
  return { ok: false, res: invalidJson() };
}
