/**
 * 长期记忆的单元测试：向量、存储去重／检索／合并／淘汰，以及引擎的抽取落盘。
 *
 * LLM 用假流驱动、不联网；只验证记忆本身的行为，不碰 DSH 宿主。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createMemoryStore } from './store.ts';
import { cosine, lexicalScore, vector } from './vector.ts';
import { createMemoryEngine, type FoundPet } from './engine.ts';
import type { FileLogger } from '../log-file.ts';

const LOG = { info: () => {}, warn: () => {}, error: () => {} } as unknown as FileLogger;

function tempWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-brain-'));
  return {
    dir,
    file: join(dir, 'brains.json'),
    configPaths: {
      defaultFile: fileURLToPath(new URL('../../../assets/config.jsonc', import.meta.url)),
      userFile: join(dir, 'main-config.jsonc'),
      petDir: join(dir, 'pet'),
    },
  };
}

function found(overrides: Record<string, unknown> = {}): FoundPet {
  return {
    entry: 'main',
    conf: { memoryEnabled: true, memoryMaxItems: 200, memorySummaryRounds: 12, chatModel: { provider: '', model: '' }, ...overrides },
    pet: { id: 'shenshen', name: '哦鯨鯨' },
  };
}

function fakeCtx(reply: string): unknown {
  return {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    llm: {
      stream: () =>
        (async function* () {
          yield { type: 'text-delta', index: 0, text: reply };
        })(),
    },
  };
}

describe('memory vector', () => {
  test('similar text scores above unrelated text', () => {
    const a = vector('主人喜歡不加糖的拿鐵');
    const b = vector('主人愛喝不加糖拿鐵');
    const c = vector('今天天氣很好適合出門');
    assert.ok(cosine(a, b) > cosine(a, c));
    assert.ok(lexicalScore('拿鐵', '主人喜歡不加糖的拿鐵', ['咖啡']) > 0);
  });
});

describe('memory store', () => {
  test('remembers, dedupes, retrieves and upserts profile', async () => {
    const ws = tempWorkspace();
    try {
      const store = createMemoryStore({ file: ws.file, log: LOG });
      const data = await store.load();
      const bucket = store.getBucket(data, 'main:shenshen');
      const latte = { kind: 'preference' as const, content: '主人喜歡不加糖的拿鐵。', keywords: ['拿鐵'], importance: 0.8, confidence: 0.9 };
      store.remember(bucket, latte, 200);
      store.remember(bucket, { kind: 'fact', content: '主人養了一隻叫 Mochi 的貓。', keywords: ['貓'], importance: 0.7, confidence: 0.8 }, 200);
      store.remember(bucket, { kind: 'fact', content: '主人正在做一個 macOS 桌寵專案。', keywords: ['專案'], importance: 0.6, confidence: 0.8 }, 200);
      store.remember(bucket, latte, 200);
      assert.equal(bucket.memories.length, 3);
      store.upsertProfile(bucket, [{ key: 'likes', value: '不加糖的拿鐵', confidence: 0.9 }]);
      const top = store.retrieve(bucket, '我喜歡喝什麼咖啡？', 3);
      assert.match(top[0].content, /拿鐵/);
      assert.equal(store.stats(bucket).profile, 1);
      await store.save(data);
      const raw = JSON.parse(readFileSync(ws.file, 'utf8')) as { buckets: Record<string, unknown> };
      assert.ok(raw.buckets['main:shenshen']);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('consolidate merges near duplicates', async () => {
    const ws = tempWorkspace();
    try {
      const store = createMemoryStore({ file: ws.file, log: LOG });
      const data = await store.load();
      const bucket = store.getBucket(data, 'main:shenshen');
      const first = store.remember(bucket, { kind: 'preference', content: '主人喜歡喝不加糖的拿鐵。', keywords: [], importance: 0.9, confidence: 0.9 }, 200);
      // 手動塞一條同樣向量的重複記錄：remember 會即時去重，consolidate 要處理的是歷史遺留的重複。
      bucket.memories.push({ ...first, id: 'dup', createdAt: first.createdAt + 1, updatedAt: first.updatedAt + 1 });
      assert.equal(bucket.memories.length, 2);
      const report = store.consolidate(bucket);
      assert.ok(report.merged >= 1);
      assert.equal(bucket.memories.length, 1);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('eviction keeps pinned memories', async () => {
    const ws = tempWorkspace();
    try {
      const store = createMemoryStore({ file: ws.file, log: LOG });
      const data = await store.load();
      const bucket = store.getBucket(data, 'main:shenshen');
      const first = store.remember(bucket, { kind: 'fact', content: '第一條要釘選的記憶。', keywords: [], importance: 0.1, confidence: 0.5 }, 2);
      first.pinned = true;
      store.remember(bucket, { kind: 'fact', content: '第二條普通記憶。', keywords: [], importance: 0.9, confidence: 0.9 }, 2);
      store.remember(bucket, { kind: 'fact', content: '第三條普通記憶。', keywords: [], importance: 0.8, confidence: 0.9 }, 2);
      store.evict(bucket, 2);
      assert.equal(bucket.memories.length, 2);
      assert.ok(bucket.memories.some((m) => m.id === first.id));
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
});

describe('memory engine', () => {
  test('afterExchange extracts a memory and a profile update', async () => {
    const ws = tempWorkspace();
    try {
      const engine = createMemoryEngine({ ctx: fakeCtx(JSON.stringify({
        memories: [{ kind: 'preference', content: '主人喜歡喝不加糖的拿鐵。', keywords: ['拿鐵'], importance: 0.8, confidence: 0.9 }],
        profile_updates: [{ key: 'likes', value: '不加糖的拿鐵', confidence: 0.9 }],
      })), configPaths: ws.configPaths, log: LOG, userRoot: ws.dir });
      const pet = found();
      await engine.afterExchange('shenshen', pet, '記住我喜歡喝不加糖的拿鐵，然後告訴我現在幾點', '好，記住了。', []);
      const listing = await engine.list(pet, 'shenshen');
      assert.equal(listing.memories.length, 1);
      assert.equal(listing.profile.likes.value, '不加糖的拿鐵');
      const context = await engine.contextFor(pet, '我喜歡喝什麼？');
      assert.match(context, /拿鐵/);
      const report = await engine.consolidate(pet, 'shenshen');
      assert.ok(report.merged >= 0);
      const view = await engine.ensureView();
      assert.ok(readFileSync(view, 'utf8').includes('哦鯨鯨的記憶'));
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('disabled memory writes nothing', async () => {
    const ws = tempWorkspace();
    try {
      const engine = createMemoryEngine({ ctx: fakeCtx('{}'), configPaths: ws.configPaths, log: LOG, userRoot: ws.dir });
      const pet = found({ memoryEnabled: false });
      await engine.afterExchange('shenshen', pet, '記住我喜歡喝不加糖的拿鐵', '好。', []);
      const listing = await engine.list(pet, 'shenshen');
      assert.equal(listing.memories.length, 0);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
});
