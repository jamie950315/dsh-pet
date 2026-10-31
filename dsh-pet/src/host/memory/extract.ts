/**
 * 記憶抽取與摘要：用宿主既有的 LLM 服務（透過 generateChat）跑 JSON 模式。
 *
 * 不碰持久化（歸 store）、不決定何時跑（歸 engine）；失敗只回 undefined 並留一行日誌，
 * 絕不让記憶整理失敗影響對話本身。
 * @module dsh-pet/src/host/memory/extract
 */
import { generateChat, type ChatMemoryMessage } from '../chat.ts';
import type { FileLogger } from '../log-file.ts';
import { configuredModel } from '../model-selection.ts';
import { MEMORY_KINDS, type ExtractionResult, type MemoryCandidate, type MemoryKind, type ProfileUpdate } from './types.ts';

/** 抽取提示詞：與 ojin 的記憶整理規則同源，改寫成 DSH 桌寵的第三人稱敘述。 */
export const EXTRACTION_PROMPT = `你是「哦鯨鯨」的記憶整理器。請從最新一輪對話中，抽取值得長期保留的資訊。

只輸出一個 JSON 物件，不要 markdown、不要解釋。格式：
{
  "memories": [
    {
      "kind": "fact | preference | episode | relationship | reflection",
      "content": "用繁體中文寫成一句可獨立理解的話",
      "keywords": ["2 到 5 個關鍵詞"],
      "importance": 0.0,
      "confidence": 0.0
    }
  ],
  "profile_updates": [
    {"key": "name | birthday | occupation | timezone | likes | dislikes | projects | goals | communication_style", "value": "繁體中文", "confidence": 0.0}
  ]
}

規則：
- 只記錄主人明確說過、且未來仍可能有用的事；不要記錄寒暄、一次性指令、工具輸出或你的猜測。
- 不要記錄密碼、API key、信用卡、身分證、私人金鑰等敏感資訊。
- content 要用第三人稱描述（例如「主人喜歡喝不加糖的拿鐵」），具體、可獨立理解。
- 同一件事不要拆成多條；最多 3 條。
- profile_updates 只放穩定屬性；不確定就不要放。
- 如果沒有值得記住的新資訊，回傳 {"memories":[],"profile_updates":[]}。`;

/** 摘要提示詞：把一段對話壓成 2–3 句長期記憶。 */
export const SUMMARY_PROMPT = `你是「哦鯨鯨」的記憶整理器。請把以下對話壓縮成 2 到 3 句、最多 180 字的繁體中文長期記憶。

只保留：主人的偏好、目標、決定、共同完成的事、未完成事項，以及值得記住的情緒脈絡。
不要記錄：工具輸出、系統資訊（電量、磁碟、時間、App 名稱）、指令、程式碼、網址、一次性問答、敏感資訊。
不要加入對話中沒有的內容；用第三人稱描述，具體、可獨立理解。
只輸出 JSON：{"summary":"..."}`;

/** 抽取的依賴。 */
export interface ExtractDeps {
  /** 宿主上下文（需有 agentDefaultModel 與 llm）。 */
  readonly ctx: unknown;
  /** 日誌出口。 */
  readonly log: FileLogger;
}

/** 剝掉 ``` 圍欄。 */
function stripFence(text: string): string {
  let value = text.trim();
  if (value.startsWith('```')) {
    const first = value.indexOf('\n');
    if (first >= 0) value = value.slice(first + 1);
    if (value.endsWith('```')) value = value.slice(0, -3);
  }
  return value.trim();
}

/** 把模型輸出解析成物件；失敗回 undefined。 */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(stripFence(text)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  return undefined;
}

/** 敏感資訊攔截：與 ojin 同一組標記。 */
const SENSITIVE = [
  'password',
  'passwd',
  'api key',
  'apikey',
  'secret',
  'private key',
  'access token',
  '密碼',
  '信用卡',
  '身分證',
  '身份證',
  '私鑰',
  '金鑰',
  '驗證碼',
  'otp',
];

/** 內容是否含敏感資訊。 */
export function containsSensitive(text: string): boolean {
  const lower = text.toLowerCase();
  return SENSITIVE.some((marker) => lower.includes(marker));
}

/** 正規化種類；未知 → fact。 */
function normalizeKind(raw: unknown): MemoryKind {
  const value = typeof raw === 'string' ? raw : 'fact';
  return (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : 'fact';
}

/** 把數值夾在 0–1。 */
function clamp01(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 抽出候選記憶與檔案更新。 */
export async function extractFromExchange(
  deps: ExtractDeps,
  options: {
    /** 寵物 id（只為日誌）。 */
    readonly petId: string;
    /** 條目成品設定（用來取 chatModel）。 */
    readonly conf: Record<string, unknown>;
    /** 使用者這輪說的話。 */
    readonly userText: string;
    /** 助理這輪的回覆。 */
    readonly assistantText: string;
    /** 最近幾輪對話（可選，提供語境）。 */
    readonly recent?: readonly ChatMemoryMessage[];
  },
): Promise<ExtractionResult | undefined> {
  const transcript = [
    ...(options.recent ?? []).slice(-6).map((m) => (m.role === 'user' ? '主人：' : '哦鯨鯨：') + m.content),
    '主人：' + options.userText,
    '哦鯨鯨：' + options.assistantText,
  ].join('\n');
  const result = await generateChat({
    ctx: deps.ctx as Parameters<typeof generateChat>[0]['ctx'],
    system: EXTRACTION_PROMPT,
    history: [],
    userText: '請整理以下對話：\n\n' + transcript,
    pool: [],
    actions: [],
    preferred: configuredModel(options.conf, 'chatModel'),
  });
  if (!result.ok) {
    deps.log.warn(`[dsh-pet] 記憶抽取失敗 pet=${options.petId}：${result.message ?? result.reason}`);
    return undefined;
  }
  const parsed = parseObject(result.text);
  if (!parsed) {
    deps.log.warn(`[dsh-pet] 記憶抽取回傳非 JSON pet=${options.petId}`);
    return undefined;
  }
  const memoriesRaw = Array.isArray(parsed.memories) ? parsed.memories : [];
  const memories: MemoryCandidate[] = [];
  for (const item of memoriesRaw.slice(0, 3)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (content.length < 3 || containsSensitive(content)) continue;
    memories.push({
      kind: normalizeKind(record.kind),
      content,
      keywords: Array.isArray(record.keywords)
        ? record.keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '').slice(0, 5)
        : [],
      importance: clamp01(record.importance, 0.5),
      confidence: clamp01(record.confidence, 0.8),
    });
  }
  const updatesRaw = Array.isArray(parsed.profile_updates) ? parsed.profile_updates : [];
  const profileUpdates: ProfileUpdate[] = [];
  for (const item of updatesRaw.slice(0, 6)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    const value = typeof record.value === 'string' ? record.value.trim() : '';
    if (!key || !value || containsSensitive(value)) continue;
    profileUpdates.push({ key, value, confidence: clamp01(record.confidence, 0.8) });
  }
  return { memories, profileUpdates };
}

/** 把一段對話摘要成 2–3 句；失敗回 undefined。 */
export async function summarizeMessages(
  deps: ExtractDeps,
  options: {
    /** 寵物 id（只為日誌）。 */
    readonly petId: string;
    /** 條目成品設定（用來取 chatModel）。 */
    readonly conf: Record<string, unknown>;
    /** 要摘要的訊息（已按時間排序）。 */
    readonly messages: readonly ChatMemoryMessage[];
  },
): Promise<string | undefined> {
  const transcript = options.messages
    .map((m) => (m.role === 'user' ? '主人：' : '哦鯨鯨：') + m.content)
    .join('\n');
  const result = await generateChat({
    ctx: deps.ctx as Parameters<typeof generateChat>[0]['ctx'],
    system: SUMMARY_PROMPT,
    history: [],
    userText: transcript,
    pool: [],
    actions: [],
    preferred: configuredModel(options.conf, 'chatModel'),
  });
  if (!result.ok) {
    deps.log.warn(`[dsh-pet] 對話摘要失敗 pet=${options.petId}：${result.message ?? result.reason}`);
    return undefined;
  }
  const parsed = parseObject(result.text);
  const summary = parsed && typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (summary.length < 5) return undefined;
  return summary.length > 360 ? summary.slice(0, 357) + '…' : summary;
}
