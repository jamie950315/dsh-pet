/**
 * 斜杠命令 /memory：查看长期记忆统计、手动记住、回想与清空。
 * @module dsh-pet/src/host/plugin/command-memory
 */
import { findPetInstance, readAllConfig } from '../config.ts';
import type { MemoryEngine } from '../memory/engine.ts';
import type { HostSetup } from './setup.ts';
import type { HostContext } from './context.ts';

/** /memory 命令的输入。 */
export type CommandMemoryInput = {
  /** 宿主上下文（apply 收到的那一个）。 */
  ctx: HostContext;
} & Pick<HostSetup, 'configPaths'> &
  Pick<HostSetup, 'log'> &
  Pick<HostSetup, 'state'> & {
    /** 长期记忆引擎。 */
    readonly memory: MemoryEngine;
    /** 当前活跃桌宠 id。 */
    readonly resolveActivePetId: () => string;
  };

/** 注册 /memory 命令；返回的清理函数由 ctx.effect 收集。 */
export function registerMemoryCommand(deps: CommandMemoryInput): void {
  const { ctx, configPaths, log, memory, resolveActivePetId, state } = deps;
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'memory',
        description: '长期记忆：list（默认）/ remember <内容> / recall <查询> / clear',
        input: { hint: 'list | remember <内容> | recall <查询> | clear' },
        handler: ({ rawInput }: { rawInput: string }) => {
          const petId = resolveActivePetId();
          if (!petId) return { kind: 'error', text: '没有可互动的桌宠' };
          const cfg = readAllConfig(configPaths);
          const found = findPetInstance(cfg, petId);
          if (!found) return { kind: 'error', text: '找不到这只桌宠：' + petId };
          const trimmed = rawInput.trim();
          const space = trimmed.indexOf(' ');
          const action = (space < 0 ? trimmed : trimmed.slice(0, space)) || 'list';
          const arg = space < 0 ? '' : trimmed.slice(space + 1).trim();
          const say = (text: string): void => {
            state.writePet(petId, 'say', { text });
          };
          if (action === 'remember' || action === '记住') {
            if (arg === '') return { kind: 'error', text: '用法：/memory remember <要记住的内容>' };
            void memory
              .add(found, petId, { kind: 'fact', content: arg, keywords: [], importance: 0.8, confidence: 0.95 })
              .then(() => say('记住了：' + arg))
              .catch((e: unknown) => log.warn('[dsh-pet] /memory remember 失败：' + (e instanceof Error ? e.message : String(e))));
            return { kind: 'success', text: '已写入长期记忆' };
          }
          if (action === 'recall' || action === '回想') {
            void memory
              .search(found, petId, arg)
              .then((list) =>
                say(list.length === 0 ? '沒有找到相關記憶。' : list.slice(0, 5).map((m) => '· ' + m.content).join('\n')),
              )
              .catch((e: unknown) => log.warn('[dsh-pet] /memory recall 失败：' + (e instanceof Error ? e.message : String(e))));
            return { kind: 'success', text: '已回想记忆，结果会显示在气泡' };
          }
          if (action === 'clear' || action === '清空') {
            void memory
              .clear(found, petId)
              .then(() => say('長期記憶已清空。'))
              .catch((e: unknown) => log.warn('[dsh-pet] /memory clear 失败：' + (e instanceof Error ? e.message : String(e))));
            return { kind: 'success', text: '已清空长期记忆' };
          }
          void memory
            .list(found, petId)
            .then((data) =>
              say(
                '長期記憶 ' +
                  data.stats.memories +
                  ' 條、主人檔案 ' +
                  data.stats.profile +
                  ' 欄位。\n瀏覽器：在 DSH 網址後加上 /dsh-pet-7340/memory/view',
              ),
            )
            .catch((e: unknown) => log.warn('[dsh-pet] /memory list 失败：' + (e instanceof Error ? e.message : String(e))));
          return { kind: 'success', text: '已读取记忆，结果会显示在气泡' };
        },
      }),
    'dsh-pet: /memory command',
  );
}
