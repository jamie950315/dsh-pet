/**
 * 飽足度／親密度路由：/stats 查詢、/feed 投餵、/pat 摸摸。
 *
 * 只做輸入驗證與轉呼叫；數值與惰性成長在 ../stats。
 * @module dsh-pet/src/host/routes/stats
 */
import { readAllConfig } from '../config.ts';
import type { RouteResult } from '../http.ts';
import { failResult, methodNotAllowed, okResult } from './result.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';

/** 相關 rest 值。 */
const STATS_RESTS = new Set(['stats', 'feed', 'pat']);

/** 投餵台詞。 */
const FEED_LINES = [
  '（捧起飯碗）白飯！本魚的算力來源！',
  '唔…這碗飯的溫度剛剛好。主人也吃一口嗎？',
  '（大口大口）才、才不是因為很餓，只是剛好想吃。',
  '吃飽了才有力氣幫主人做事…大概吧。',
];

/** 摸摸台詞。 */
const PAT_LINES = [
  '（鰭耳抖了一下）摸、摸頭是可以啦…',
  '哼，本魚才沒有很開心。…再摸一下也可以。',
  '（尾巴慢慢晃）主人的手暖暖的。',
  '別摸太久，呆毛會亂掉啦。',
];

/** 隨機挑一句。 */
function pick(lines: readonly string[]): string {
  return lines[Math.floor(Math.random() * lines.length)] ?? lines[0];
}

/** 飽足度／親密度領域：未命中回 undefined。 */
export async function handleStatsRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { rest, method, url } = input;
  if (!STATS_RESTS.has(rest)) return undefined;
  let cache: Record<string, Record<string, unknown>> | undefined;
  const cfg = (): Record<string, Record<string, unknown>> => (cache ??= readAllConfig(deps.configPaths));
  const who = deps.requirePet(url.searchParams, cfg, { surface: false });
  if (!who.ok) return who.res;
  const petId = who.petId;
  try {
    if (rest === 'stats') {
      if (method !== 'GET') return methodNotAllowed();
      const stats = await deps.stats.get(petId);
      return okResult({
        ok: true,
        petId,
        stats,
        affinityLabel: deps.stats.affinityLabel(stats.affinity),
        hungerLabel: deps.stats.hungerLabel(stats.hunger),
      });
    }
    if (method !== 'POST') return methodNotAllowed();
    if (rest === 'feed') {
      const stats = await deps.stats.feed(petId);
      const line = pick(FEED_LINES);
      deps.state.writePet(petId, 'say', { text: line });
      return okResult({ ok: true, petId, stats, line, affinityLabel: deps.stats.affinityLabel(stats.affinity), hungerLabel: deps.stats.hungerLabel(stats.hunger) });
    }
    const stats = await deps.stats.pat(petId);
    const line = pick(PAT_LINES);
    deps.state.writePet(petId, 'say', { text: line });
    return okResult({ ok: true, petId, stats, line, affinityLabel: deps.stats.affinityLabel(stats.affinity), hungerLabel: deps.stats.hungerLabel(stats.hunger) });
  } catch (e) {
    return failResult('generate-error', e instanceof Error ? e.message : String(e));
  }
}
