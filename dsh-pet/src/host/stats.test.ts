/**
 * 飽足度／親密度的單元測試：投餵、摸摸與惰性成長。
 * @module dsh-pet/src/host/stats.test
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStatsStore, HUNGER_PER_HOUR } from './stats.ts';
import type { FileLogger } from './log-file.ts';

const LOG = { info: () => {}, warn: () => {}, error: () => {} } as unknown as FileLogger;

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pet-stats-'));
  return { dir, file: join(dir, 'stats.json'), store: createStatsStore({ file: join(dir, 'stats.json'), log: LOG }) };
}

describe('pet stats', () => {
  test('defaults then feed lowers hunger and raises affinity', async () => {
    const ws = tempStore();
    try {
      const before = await ws.store.get('main');
      assert.equal(before.affinity, 35);
      assert.equal(before.hunger, 30);
      const fed = await ws.store.feed('main');
      assert.ok(fed.hunger < before.hunger);
      assert.ok(fed.affinity > before.affinity);
      const patted = await ws.store.pat('main');
      assert.ok(patted.affinity > fed.affinity);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });

  test('hunger grows lazily with elapsed time', async () => {
    const ws = tempStore();
    try {
      const twoHoursAgo = Date.now() - 2 * 3_600_000;
      writeFileSync(ws.file, JSON.stringify({ version: 1, pets: { main: { affinity: 35, hunger: 30, updatedAt: twoHoursAgo, lastInteractionAt: twoHoursAgo } } }));
      const now = await ws.store.get('main');
      assert.ok(now.hunger >= 30 + 2 * HUNGER_PER_HOUR - 0.5);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
});
