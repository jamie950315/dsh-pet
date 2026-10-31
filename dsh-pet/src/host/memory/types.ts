/**
 * 長期記憶的資料形狀（ojin 合併）：與 dsh-pet 既有的 memory.json（對話輪）並存，
 * 單獨落在 brains.json，避免動到既有對話歷史的讀寫語意。
 *
 * 記憶以「條目 + 寵物實例」為桶；同一隻寵物的實例級記憶不跨寵物共享。
 * @module dsh-pet/src/host/memory/types
 */

/** 記憶種類：與 ojin 的五類一致，供檢索加權與使用者介面分組。 */
export type MemoryKind = 'fact' | 'preference' | 'episode' | 'relationship' | 'reflection';

/** 全部記憶種類（穩定順序，供 UI 與匯出使用）。 */
export const MEMORY_KINDS: readonly MemoryKind[] = [
  'fact',
  'preference',
  'episode',
  'relationship',
  'reflection',
];

/** 一條長期記憶。 */
export interface MemoryRecord {
  /** 穩定 id（時間戳 + 隨機後綴），刪除與更新都用它。 */
  id: string;
  /** 記憶種類。 */
  kind: MemoryKind;
  /** 一句可獨立理解的繁體中文敘述。 */
  content: string;
  /** 檢索用關鍵詞。 */
  keywords: string[];
  /** 重要度 0–1。 */
  importance: number;
  /** 信心 0–1。 */
  confidence: number;
  /** 建立時間（毫秒）。 */
  createdAt: number;
  /** 最後更新時間（毫秒）。 */
  updatedAt: number;
  /** 最後被檢索取用時間（毫秒）。 */
  lastAccessedAt: number;
  /** 被檢索取用次數。 */
  accessCount: number;
  /** 釘選：不參與衰減與淘汰。 */
  pinned: boolean;
  /** 來源：conversation / explicit / summary。 */
  source: string;
  /** 預先算好的向量（Float64Array 不適合 JSON，存普通數字陣列）。 */
  vector: number[];
}

/** 使用者檔案的一條欄位。 */
export interface ProfileEntry {
  /** 欄位值（繁體中文）。 */
  value: string;
  /** 信心 0–1。 */
  confidence: number;
  /** 最後更新時間（毫秒）。 */
  updatedAt: number;
}

/** 單一「條目 + 寵物」的記憶桶。 */
export interface MemoryBucket {
  /** 使用者檔案：key → 值。 */
  profile: Record<string, ProfileEntry>;
  /** 長期記憶清單。 */
  memories: MemoryRecord[];
  /** 已摘要到的對話訊息 ts（毫秒）；0 = 尚未摘要。 */
  lastSummarizedTs: number;
  /** 最後一次維護（合併／衰減）時間（毫秒）。 */
  lastConsolidatedAt: number;
  /** 最後更新時間（毫秒）。 */
  updatedAt: number;
}

/** brains.json 的根。 */
export interface BrainFile {
  /** 檔案格式版本，未來遷移用。 */
  version: 1;
  /** 桶：`<entry>:<petId>` → 記憶。 */
  buckets: Record<string, MemoryBucket>;
}

/** 抽取模型回傳的一條候選記憶。 */
export interface MemoryCandidate {
  /** 種類。 */
  kind: MemoryKind;
  /** 內容。 */
  content: string;
  /** 關鍵詞。 */
  keywords: string[];
  /** 重要度 0–1。 */
  importance: number;
  /** 信心 0–1。 */
  confidence: number;
}

/** 抽取模型回傳的檔案更新。 */
export interface ProfileUpdate {
  /** 欄位名稱（穩定英文 key）。 */
  key: string;
  /** 值。 */
  value: string;
  /** 信心 0–1。 */
  confidence: number;
}

/** 一輪抽取的結果。 */
export interface ExtractionResult {
  /** 候選記憶。 */
  memories: MemoryCandidate[];
  /** 檔案更新。 */
  profileUpdates: ProfileUpdate[];
}

/** 建立一個空桶。 */
export function emptyBucket(): MemoryBucket {
  return { profile: {}, memories: [], lastSummarizedTs: 0, lastConsolidatedAt: 0, updatedAt: 0 };
}

/** 建立空的記憶檔。 */
export function emptyBrainFile(): BrainFile {
  return { version: 1, buckets: {} };
}
