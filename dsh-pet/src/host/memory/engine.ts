/**
 * 長期記憶引擎：把 store（持久化／檢索）、extract（LLM 抽取／摘要）與人設注入串成一個門面。
 *
 * 對話層只呼叫 contextFor / afterExchange；路由層只呼叫 list / add / update / remove / clear /
 * consolidate / export。引擎自己不做排程——維護迴圈由 index.ts 用 ctx.effect 掛上。
 * @module dsh-pet/src/host/memory/engine
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMemoryMessage } from '../chat.ts';
import type { ConfigPaths } from '../config.ts';
import type { FileLogger } from '../log-file.ts';
import { extractFromExchange, summarizeMessages } from './extract.ts';
import { bucketKey, createMemoryStore } from './store.ts';
import type { BrainFile, MemoryBucket, MemoryCandidate, MemoryRecord, ProfileEntry } from './types.ts';
import { MEMORY_VIEW_HTML } from './view.ts';

/** 已定位的寵物（與 config.findPetInstance 的命中形狀一致）。 */
export interface FoundPet {
  /** 條目 key（= 素材根）。 */
  readonly entry: string;
  /** 該條目的成品設定。 */
  readonly conf: Record<string, unknown>;
  /** 該寵物實例。 */
  readonly pet: Record<string, unknown>;
}

/** 引擎依賴。 */
export interface MemoryEngineDeps {
  /** 宿主上下文（需有 agentDefaultModel 與 llm）。 */
  readonly ctx: unknown;
  /** 配置路徑集。 */
  readonly configPaths: ConfigPaths;
  /** 日誌出口。 */
  readonly log: FileLogger;
  /** 使用者資料根。 */
  readonly userRoot: string;
}

/** 使用者檔案 key → 中文標籤。 */
const PROFILE_LABELS: Record<string, string> = {
  name: '名字',
  birthday: '生日',
  occupation: '工作',
  timezone: '時區',
  likes: '喜歡',
  dislikes: '不喜歡',
  projects: '專案',
  goals: '目標',
  communication_style: '溝通偏好',
};

/** 標籤查詢。 */
function profileLabel(key: string): string {
  return PROFILE_LABELS[key] ?? key;
}

/** 重要度 → 星號。 */
function stars(importance: number): string {
  if (importance >= 0.8) return '★★★';
  if (importance >= 0.55) return '★★';
  return '★';
}

/** 建立長期記憶引擎。 */
export function createMemoryEngine(deps: MemoryEngineDeps) {
  const { ctx, log, userRoot } = deps;
  const store = createMemoryStore({ file: join(userRoot, 'brains.json'), log });
  const viewFile = join(userRoot, 'memory-view.html');
  let viewWritten = false;

  /** 條目是否啟用長期記憶（預設開啟）。 */
  const enabled = (conf: Record<string, unknown>): boolean => conf.memoryEnabled !== false;

  /** 每桶記憶上限。 */
  const maxItems = (conf: Record<string, unknown>): number => {
    const n = Number(conf.memoryMaxItems);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 200;
  };

  /** 每累積多少輪對話做一次摘要。 */
  const summaryRounds = (conf: Record<string, unknown>): number => {
    const n = Number(conf.memorySummaryRounds);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 12;
  };

  /** 取桶。 */
  const bucketOf = (data: BrainFile, found: FoundPet, petId: string): MemoryBucket =>
    store.getBucket(data, bucketKey(found.entry, petId));

  /** 格式化使用者檔案區塊。 */
  const formatProfile = (bucket: MemoryBucket): string => {
    const entries = Object.entries(bucket.profile);
    if (entries.length === 0) return '';
    return [
      '【主人檔案】',
      ...entries.map(([key, value]) => '- ' + profileLabel(key) + '：' + value.value),
    ].join('\n');
  };

  /** 格式化檢索到的記憶。 */
  const formatMemories = (memories: readonly MemoryRecord[]): string => {
    if (memories.length === 0) return '';
    return [
      '【相關長期記憶】',
      ...memories.map((m) => '- [' + m.kind + ' ' + stars(m.importance) + '] ' + m.content),
    ].join('\n');
  };

  /** 取出注入對話的記憶區塊（檔案 + 與本輪相關的記憶）。 */
  const contextFor = async (found: FoundPet, query: string): Promise<string> => {
    if (!enabled(found.conf)) return '';
    const petId = String(found.pet.id ?? '');
    if (petId === '') return '';
    const data = await store.load();
    const bucket = bucketOf(data, found, petId);
    const retrieved = store.retrieve(bucket, query, 8);
    if (retrieved.length > 0) await store.save(data);
    const parts = [formatProfile(bucket), formatMemories(retrieved)].filter((part) => part !== '');
    if (parts.length === 0) return '';
    return parts.join('\n').slice(0, 1800);
  };

  /** 只取使用者檔案（碎碎念用，短）。 */
  const profileContextFor = async (found: FoundPet): Promise<string> => {
    if (!enabled(found.conf)) return '';
    const petId = String(found.pet.id ?? '');
    if (petId === '') return '';
    const data = await store.load();
    const bucket = bucketOf(data, found, petId);
    return formatProfile(bucket).slice(0, 600);
  };

  /** 一輪對話結束後：抽取記憶、更新檔案、必要時摘要；不阻塞回覆。 */
  const afterExchange = async (
    petId: string,
    found: FoundPet,
    userText: string,
    assistantText: string,
    allMessages: readonly ChatMemoryMessage[],
  ): Promise<void> => {
    if (!enabled(found.conf)) return;
    if (userText.trim().length < 2 && assistantText.trim().length < 8) return;
    const max = maxItems(found.conf);
    const rounds = summaryRounds(found.conf);
    const extraction = await extractFromExchange(
      { ctx, log },
      { petId, conf: found.conf, userText, assistantText, recent: allMessages.slice(-6) },
    );
    let merged = 0;
    let summarized = 0;
    await store.withLock(async () => {
      const data = await store.load();
      const bucket = bucketOf(data, found, petId);
      if (extraction) {
        for (const candidate of extraction.memories) {
          store.remember(bucket, candidate, max);
          merged += 1;
        }
        store.upsertProfile(bucket, extraction.profileUpdates);
      }
      if (rounds > 0) {
        const pending = allMessages.filter((m) => m.ts > bucket.lastSummarizedTs);
        if (pending.length >= rounds * 2) {
          const slice = pending.slice(0, Math.max(rounds * 2, 12));
          const summary = await summarizeMessages({ ctx, log }, { petId, conf: found.conf, messages: slice });
          if (summary) {
            const candidate: MemoryCandidate = {
              kind: 'episode',
              content: summary,
              keywords: ['對話摘要'],
              importance: 0.62,
              confidence: 0.85,
            };
            store.remember(bucket, candidate, max, 'summary');
            bucket.lastSummarizedTs = slice[slice.length - 1].ts;
            summarized += 1;
          }
        }
      }
      await store.save(data);
    });
    log.info(`[dsh-pet] 記憶整理完成 pet=${petId}：新增/合併 ${merged} 條、摘要 ${summarized} 條`);
  };

  /** 讀取清單。 */
  const list = async (found: FoundPet, petId: string): Promise<{ profile: Record<string, ProfileEntry>; memories: MemoryRecord[]; stats: ReturnType<typeof store.stats> }> => {
    const data = await store.load();
    const bucket = bucketOf(data, found, petId);
    return { profile: bucket.profile, memories: [...bucket.memories].sort((a, b) => b.updatedAt - a.updatedAt), stats: store.stats(bucket) };
  };

  /** 搜尋。 */
  const search = async (found: FoundPet, petId: string, query: string): Promise<MemoryRecord[]> => {
    const data = await store.load();
    return store.search(bucketOf(data, found, petId), query);
  };

  /** 手動新增一條記憶。 */
  const add = async (found: FoundPet, petId: string, candidate: MemoryCandidate, pinned = false): Promise<MemoryRecord> => {
    return store.withLock(async () => {
      const data = await store.load();
      const bucket = bucketOf(data, found, petId);
      const record = store.remember(bucket, candidate, maxItems(found.conf), 'explicit');
      if (pinned) record.pinned = true;
      await store.save(data);
      return record;
    });
  };

  /** 更新一條記憶。 */
  const update = async (found: FoundPet, petId: string, id: string, patch: { content?: string; importance?: number; pinned?: boolean }): Promise<MemoryRecord | undefined> => {
    return store.withLock(async () => {
      const data = await store.load();
      const bucket = bucketOf(data, found, petId);
      const record = store.update(bucket, id, patch);
      if (record) await store.save(data);
      return record;
    });
  };

  /** 刪除一條記憶。 */
  const remove = async (found: FoundPet, petId: string, id: string): Promise<boolean> => {
    return store.withLock(async () => {
      const data = await store.load();
      const bucket = bucketOf(data, found, petId);
      const ok = store.remove(bucket, id);
      if (ok) await store.save(data);
      return ok;
    });
  };

  /** 清空一隻寵物的記憶。 */
  const clear = async (found: FoundPet, petId: string): Promise<void> => {
    await store.withLock(async () => {
      const data = await store.load();
      const bucket = bucketOf(data, found, petId);
      store.clear(bucket);
      await store.save(data);
    });
  };

  /** 重整（合併／衰減）；未給寵物則對全部桶執行。 */
  const consolidate = async (found?: FoundPet, petId?: string): Promise<{ merged: number; decayed: number; removed: number }> => {
    return store.withLock(async () => {
      const data = await store.load();
      const result = { merged: 0, decayed: 0, removed: 0 };
      const keys = found && petId ? [bucketKey(found.entry, petId)] : Object.keys(data.buckets);
      for (const key of keys) {
        const bucket = data.buckets[key];
        if (!bucket) continue;
        const report = store.consolidate(bucket);
        result.merged += report.merged;
        result.decayed += report.decayed;
        result.removed += report.removed;
      }
      await store.save(data);
      return result;
    });
  };

  /** 匯出。 */
  const exportBucket = async (found: FoundPet, petId: string): Promise<Record<string, unknown>> => {
    const data = await store.load();
    const bucket = bucketOf(data, found, petId);
    return { exportedAt: new Date().toISOString(), petId, entry: found.entry, ...bucket };
  };

  /** 確保存檔瀏覽器 HTML 已寫出，回傳路徑。 */
  const ensureView = async (): Promise<string> => {
    if (!viewWritten) {
      try {
        await writeFile(viewFile, MEMORY_VIEW_HTML, 'utf8');
        viewWritten = true;
      } catch (e) {
        log.warn(`[dsh-pet] 記憶瀏覽器 HTML 寫入失敗：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return viewFile;
  };

  /** 背景維護迴圈：每 6 小時合併／衰減一次；回傳清理函式。 */
  const startMaintenance = (): (() => void) => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (): void => {
      if (disposed) return;
      timer = setTimeout(() => void run(), 6 * 3600 * 1000);
      (timer as { unref?: () => void }).unref?.();
    };
    const run = async (): Promise<void> => {
      try {
        await consolidate();
      } catch (e) {
        log.warn(`[dsh-pet] 記憶維護失敗：${e instanceof Error ? e.message : String(e)}`);
      }
      arm();
    };
    void ensureView();
    arm();
    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  };

  return {
    store,
    enabled,
    maxItems,
    summaryRounds,
    contextFor,
    profileContextFor,
    afterExchange,
    list,
    search,
    add,
    update,
    remove,
    clear,
    consolidate,
    exportBucket,
    ensureView,
    startMaintenance,
  };
}

/** 長期記憶引擎型別。 */
export type MemoryEngine = ReturnType<typeof createMemoryEngine>;
