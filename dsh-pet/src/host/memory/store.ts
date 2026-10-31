/**
 * 長期記憶的持久化與檢索：brains.json 的唯一讀寫方。
 *
 * 與 memory.json（對話輪）分開：這裡存的是使用者檔案與跨對話記憶，
 * 讀寫經同一個串行佇列，避免對話與維護迴圈交錯覆寫。
 * @module dsh-pet/src/host/memory/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileLogger } from '../log-file.ts';
import {
  emptyBrainFile,
  emptyBucket,
  type BrainFile,
  type MemoryBucket,
  type MemoryCandidate,
  type MemoryRecord,
  type ProfileUpdate,
} from './types.ts';
import { cosine, lexicalScore, vector } from './vector.ts';

/** 記憶儲存的依賴。 */
export interface MemoryStoreDeps {
  /** brains.json 絕對路徑。 */
  readonly file: string;
  /** 日誌出口。 */
  readonly log: FileLogger;
}

/** 記憶桶的鍵：條目 + 寵物實例。 */
export function bucketKey(entry: string, petId: string): string {
  return entry + ':' + petId;
}

/** 建立一條記憶 id。 */
function newId(): string {
  return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** 記憶資料的讀寫與檢索。 */
export function createMemoryStore(deps: MemoryStoreDeps) {
  const { file, log } = deps;
  let queue: Promise<void> = Promise.resolve();

  /** 把一次讀改寫封進串行佇列。 */
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** 讀檔：不存在／解析失敗 → 空檔（不備份、不改寫來源）。 */
  const load = async (): Promise<BrainFile> => {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return emptyBrainFile();
    }
    try {
      const parsed = JSON.parse(raw) as BrainFile;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.buckets !== 'object' || parsed.buckets === null) {
        throw new Error('not a brain file');
      }
      return parsed;
    } catch (e) {
      log.error(`[dsh-pet] 長期記憶檔無法解析，已從空檔繼續：${file}（${e instanceof Error ? e.message : String(e)}）`);
      return emptyBrainFile();
    }
  };

  /** 原子寫檔：先寫 .tmp 再 rename，避免行程中斷留下半截 JSON。 */
  const save = async (data: BrainFile): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  };

  /** 取桶：不存在就建立。 */
  const getBucket = (data: BrainFile, key: string): MemoryBucket => {
    const existing = data.buckets[key];
    if (existing && typeof existing === 'object') {
      if (!existing.profile || typeof existing.profile !== 'object') existing.profile = {};
      if (!Array.isArray(existing.memories)) existing.memories = [];
      if (!Number.isFinite(existing.lastSummarizedTs)) existing.lastSummarizedTs = 0;
      if (!Number.isFinite(existing.lastConsolidatedAt)) existing.lastConsolidatedAt = 0;
      return existing;
    }
    const bucket = emptyBucket();
    data.buckets[key] = bucket;
    return bucket;
  };

  /** 同種類且內容幾乎相同 → 回傳既有那條（用於去重）。 */
  const findDuplicate = (data: MemoryBucket, candidate: MemoryCandidate): MemoryRecord | undefined => {
    const vec = vector(candidate.content);
    for (const memory of data.memories) {
      if (memory.kind !== candidate.kind) continue;
      if (memory.content.trim() === candidate.content.trim()) return memory;
      if (cosine(vec, memory.vector) > 0.92) return memory;
    }
    return undefined;
  };

  /** 寫入或合併一條記憶；回傳最終記錄。 */
  const remember = (
    bucket: MemoryBucket,
    candidate: MemoryCandidate,
    maxItems: number,
    source = 'conversation',
  ): MemoryRecord => {
    const content = candidate.content.trim();
    const existing = findDuplicate(bucket, { ...candidate, content });
    const now = Date.now();
    if (existing) {
      if (content.length > existing.content.length) {
        existing.content = content;
        existing.vector = vector(content);
      }
      existing.importance = Math.max(existing.importance, candidate.importance);
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.keywords = [...new Set([...existing.keywords, ...candidate.keywords])].slice(0, 8);
      existing.updatedAt = now;
      bucket.updatedAt = now;
      return existing;
    }
    const record: MemoryRecord = {
      id: newId(),
      kind: candidate.kind,
      content,
      keywords: candidate.keywords.slice(0, 8),
      importance: Math.min(1, Math.max(0, candidate.importance)),
      confidence: Math.min(1, Math.max(0, candidate.confidence)),
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      pinned: false,
      source,
      vector: vector(content),
    };
    bucket.memories.push(record);
    bucket.updatedAt = now;
    evict(bucket, maxItems);
    return record;
  };

  /** 淘汰：超過上限時，按「重要度 + 釘選 + 新近度」保留前 N 條（釘選永不淘汰）。 */
  const evict = (bucket: MemoryBucket, maxItems: number): void => {
    if (maxItems <= 0 || bucket.memories.length <= maxItems) return;
    const now = Date.now();
    const score = (m: MemoryRecord): number =>
      m.importance + (m.pinned ? 10 : 0) + Math.max(0, 1 - (now - m.updatedAt) / (90 * 86_400_000));
    const keep = [...bucket.memories].sort((a, b) => score(b) - score(a)).slice(0, maxItems);
    bucket.memories = keep.sort((a, b) => a.createdAt - b.createdAt);
  };

  /** 更新檔案欄位。 */
  const upsertProfile = (bucket: MemoryBucket, updates: readonly ProfileUpdate[]): void => {
    const now = Date.now();
    for (const update of updates) {
      const key = update.key.trim();
      const value = update.value.trim();
      if (!key || !value) continue;
      bucket.profile[key] = {
        value,
        confidence: Math.min(1, Math.max(0, update.confidence)),
        updatedAt: now,
      };
    }
    bucket.updatedAt = now;
  };

  /** 刪除一條記憶。 */
  const remove = (bucket: MemoryBucket, id: string): boolean => {
    const before = bucket.memories.length;
    bucket.memories = bucket.memories.filter((m) => m.id !== id);
    bucket.updatedAt = Date.now();
    return bucket.memories.length !== before;
  };

  /** 更新一條記憶的可編輯欄位。 */
  const update = (
    bucket: MemoryBucket,
    id: string,
    patch: { content?: string; importance?: number; pinned?: boolean },
  ): MemoryRecord | undefined => {
    const memory = bucket.memories.find((m) => m.id === id);
    if (!memory) return undefined;
    if (typeof patch.content === 'string' && patch.content.trim() !== '') {
      memory.content = patch.content.trim();
      memory.vector = vector(memory.content);
    }
    if (typeof patch.importance === 'number' && Number.isFinite(patch.importance)) {
      memory.importance = Math.min(1, Math.max(0, patch.importance));
    }
    if (typeof patch.pinned === 'boolean') memory.pinned = patch.pinned;
    memory.updatedAt = Date.now();
    bucket.updatedAt = memory.updatedAt;
    return memory;
  };

  /** 清空桶。 */
  const clear = (bucket: MemoryBucket): void => {
    bucket.profile = {};
    bucket.memories = [];
    bucket.lastSummarizedTs = 0;
    bucket.lastConsolidatedAt = 0;
    bucket.updatedAt = Date.now();
  };

  /** 統計。 */
  const stats = (bucket: MemoryBucket): { memories: number; pinned: number; profile: number; kinds: Record<string, number> } => {
    const kinds: Record<string, number> = {};
    for (const memory of bucket.memories) kinds[memory.kind] = (kinds[memory.kind] ?? 0) + 1;
    return {
      memories: bucket.memories.length,
      pinned: bucket.memories.filter((m) => m.pinned).length,
      profile: Object.keys(bucket.profile).length,
      kinds,
    };
  };

  /** 檢索：語意 + 詞彙 + 重要度 + 新近度；回傳前 N 條並更新存取統計。 */
  const retrieve = (bucket: MemoryBucket, query: string, limit: number): MemoryRecord[] => {
    const trimmed = query.trim();
    if (trimmed === '') {
      return [...bucket.memories]
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.importance - a.importance || b.updatedAt - a.updatedAt)
        .slice(0, limit);
    }
    const qvec = vector(trimmed);
    const now = Date.now();
    const scored = bucket.memories.map((memory) => {
      const semantic = cosine(qvec, memory.vector);
      const lexical = lexicalScore(trimmed, memory.content, memory.keywords);
      const ageDays = Math.max(0, (now - memory.lastAccessedAt) / 86_400_000);
      const recency = Math.exp(-ageDays / 45);
      const access = Math.min(1, Math.log1p(memory.accessCount) / Math.log(10));
      const score =
        0.5 * semantic + 0.2 * lexical + 0.15 * memory.importance + 0.09 * recency + 0.06 * access + (memory.pinned ? 0.08 : 0);
      return { memory, score };
    });
    const picked = scored
      .filter((x) => x.score > 0.12)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.memory);
    for (const memory of picked) {
      memory.lastAccessedAt = now;
      memory.accessCount += 1;
    }
    return picked;
  };

  /** 搜尋（UI 用）：內容與關鍵詞的子字串比對。 */
  const search = (bucket: MemoryBucket, query: string): MemoryRecord[] => {
    const q = query.trim().toLowerCase();
    if (q === '') return [...bucket.memories].sort((a, b) => b.updatedAt - a.updatedAt);
    return bucket.memories
      .filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          m.keywords.some((k) => k.toLowerCase().includes(q)) ||
          m.kind.toLowerCase().includes(q),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  };

  /** 維護：合併近似記憶、衰減久未使用的記憶。 */
  const consolidate = (bucket: MemoryBucket): { merged: number; decayed: number; removed: number } => {
    let merged = 0;
    let decayed = 0;
    let removed = 0;
    const kept: MemoryRecord[] = [];
    for (const memory of [...bucket.memories].sort((a, b) => b.importance - a.importance)) {
      const duplicate = kept.find(
        (other) => other.kind === memory.kind && cosine(other.vector, memory.vector) > 0.92,
      );
      if (duplicate) {
        if (memory.content.length > duplicate.content.length) {
          duplicate.content = memory.content;
          duplicate.vector = memory.vector;
        }
        duplicate.importance = Math.max(duplicate.importance, memory.importance);
        duplicate.keywords = [...new Set([...duplicate.keywords, ...memory.keywords])].slice(0, 8);
        duplicate.updatedAt = Math.max(duplicate.updatedAt, memory.updatedAt);
        merged += 1;
        continue;
      }
      kept.push(memory);
    }
    const now = Date.now();
    bucket.memories = kept.filter((memory) => {
      if (memory.pinned) return true;
      const days = (now - memory.lastAccessedAt) / 86_400_000;
      if (days <= 30) return true;
      const next = memory.importance * Math.pow(0.97, days - 30);
      if (next < 0.12) {
        removed += 1;
        return false;
      }
      if (next < memory.importance - 0.001) {
        memory.importance = next;
        decayed += 1;
      }
      return true;
    });
    bucket.lastConsolidatedAt = now;
    bucket.updatedAt = now;
    return { merged, decayed, removed };
  };

  return { withLock, load, save, getBucket, remember, upsertProfile, remove, update, clear, stats, retrieve, search, consolidate, evict };
}

/** 記憶儲存型別。 */
export type MemoryStore = ReturnType<typeof createMemoryStore>;
