/**
 * 飽足度／親密度：與長期記憶同一個使用者資料根，單獨落 stats.json。
 *
 * 飽足度採惰性成長（讀取時按經過時間計算），不需要常駐定時器；
 * 只有投餵／摸摸等互動才寫盤，避免無意義的頻繁寫入。
 * @module dsh-pet/src/host/stats
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FileLogger } from './log-file.ts';

/** 每小時增加的飽足度（0–100 尺度）。 */
export const HUNGER_PER_HOUR = 7.2;

/** 投餵一次降低的飽足度。 */
export const FEED_HUNGER_DELTA = 35;

/** 投餵一次增加的親密度。 */
export const FEED_AFFINITY_DELTA = 3;

/** 摸摸一次增加的親密度。 */
export const PAT_AFFINITY_DELTA = 1.2;

/** 一隻寵物的互動數值。 */
export interface PetStats {
  /** 親密度 0–100。 */
  affinity: number;
  /** 飽足度 0–100（越大越餓）。 */
  hunger: number;
  /** 最後一次寫盤時間（毫秒）。 */
  updatedAt: number;
  /** 最後一次互動時間（毫秒）。 */
  lastInteractionAt: number;
}

/** 檔案根。 */
interface StatsFile {
  version: 1;
  pets: Record<string, PetStats>;
}

/** 建立飽足度／親密度儲存。 */
export function createStatsStore(deps: { file: string; log: FileLogger }) {
  const { file, log } = deps;
  let queue: Promise<void> = Promise.resolve();

  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const load = async (): Promise<StatsFile> => {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return { version: 1, pets: {} }; // 檔案不存在 = 還沒有互動
    }
    try {
      const parsed = JSON.parse(raw) as StatsFile;
      if (parsed && typeof parsed === 'object' && parsed.pets && typeof parsed.pets === 'object') return parsed;
      throw new Error('not a stats file');
    } catch (e) {
      log.warn('[dsh-pet] stats.json 解析失敗，已從預設繼續：' + file + '（' + (e instanceof Error ? e.message : String(e)) + '）');
      return { version: 1, pets: {} };
    }
  };

  const save = async (data: StatsFile): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  };

  /** 惰性成長後的實際值；不寫盤。 */
  const effective = (record: PetStats): PetStats => {
    const hours = Math.max(0, (Date.now() - record.updatedAt) / 3_600_000);
    return { ...record, hunger: Math.min(100, record.hunger + hours * HUNGER_PER_HOUR) };
  };

  /** 讀取一隻寵物的實際值。 */
  const get = async (petId: string): Promise<PetStats> => {
    const data = await load();
    const record = data.pets[petId] ?? { affinity: 35, hunger: 30, updatedAt: Date.now(), lastInteractionAt: Date.now() };
    return effective(record);
  };

  /** 投餵：飽足度下降、親密度上升，寫盤並回傳新值。 */
  const feed = async (petId: string): Promise<PetStats> =>
    withLock(async () => {
      const data = await load();
      const current = effective(data.pets[petId] ?? { affinity: 35, hunger: 30, updatedAt: Date.now(), lastInteractionAt: Date.now() });
      const next: PetStats = {
        affinity: Math.min(100, current.affinity + FEED_AFFINITY_DELTA),
        hunger: Math.max(0, current.hunger - FEED_HUNGER_DELTA),
        updatedAt: Date.now(),
        lastInteractionAt: Date.now(),
      };
      data.pets[petId] = next;
      await save(data);
      return next;
    });

  /** 摸摸：親密度上升，寫盤並回傳新值。 */
  const pat = async (petId: string): Promise<PetStats> =>
    withLock(async () => {
      const data = await load();
      const current = effective(data.pets[petId] ?? { affinity: 35, hunger: 30, updatedAt: Date.now(), lastInteractionAt: Date.now() });
      const next: PetStats = {
        affinity: Math.min(100, current.affinity + PAT_AFFINITY_DELTA),
        hunger: current.hunger,
        updatedAt: Date.now(),
        lastInteractionAt: Date.now(),
      };
      data.pets[petId] = next;
      await save(data);
      return next;
    });

  /** 清空某隻寵物的數值（設定頁／除錯用）。 */
  const clear = async (petId: string): Promise<void> =>
    withLock(async () => {
      const data = await load();
      delete data.pets[petId];
      await save(data);
    });

  /** 親密度標籤。 */
  const affinityLabel = (affinity: number): string => {
    if (affinity < 25) return '有點陌生';
    if (affinity < 50) return '慢慢熟悉';
    if (affinity < 70) return '朋友';
    if (affinity < 88) return '黏人';
    return '最喜歡主人';
  };

  /** 飽足度標籤。 */
  const hungerLabel = (hunger: number): string => {
    if (hunger < 25) return '吃飽了';
    if (hunger < 55) return '還好';
    if (hunger < 80) return '有點餓';
    return '餓扁了';
  };

  return { get, feed, pat, clear, affinityLabel, hungerLabel };
}

/** 飽足度／親密度儲存型別。 */
export type StatsStore = ReturnType<typeof createStatsStore>;
