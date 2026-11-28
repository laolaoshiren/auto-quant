import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Db } from './index.js';

test('Db enables INCREMENTAL auto_vacuum on fresh DB and reclaims freelist pages in maintenance()', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aq-db-maint-'));
  const file = path.join(dir, 'test.sqlite');
  const db = new Db(file);
  try {
    db.exec('CREATE TABLE blobs (id INTEGER PRIMARY KEY, body TEXT)');
    const payload = 'x'.repeat(8000);
    db.transaction(() => {
      for (let i = 0; i < 400; i++) {
        db.run('INSERT INTO blobs (body) VALUES (?)', payload);
      }
    });

    // WAL 模式下先落盘一次，确保主库文件已物化全部数据页，再测删表后的缩容效果
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const sizeBeforeDelete = statSync(file).size;
    db.run('DELETE FROM blobs');

    const res = db.maintenance({
      minFreelistPages: 16,
      maxVacuumPages: 2048,
      checkpointMode: 'TRUNCATE',
    });

    assert.equal(res.autoVacuumMode, 2, 'fresh database should enable auto_vacuum = INCREMENTAL');
    assert.ok(res.freelistBefore > 100, `expected >100 freelist pages, got ${res.freelistBefore}`);
    assert.ok(res.reclaimedPages > 100, `expected >100 reclaimed pages, got ${res.reclaimedPages}`);
    assert.ok(res.freelistAfter < res.freelistBefore, 'freelist should drop after incremental_vacuum');

    const sizeAfter = statSync(file).size;
    assert.ok(
      sizeAfter < sizeBeforeDelete * 0.5,
      `expected file size to shrink materially: before=${sizeBeforeDelete}, after=${sizeAfter}`,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Db.maintenance() skips incremental_vacuum when freelist is below threshold', () => {
  const db = new Db(':memory:');
  try {
    db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
    db.run('INSERT INTO kv VALUES (?, ?)', 'a', '1');
    const res = db.maintenance({ minFreelistPages: 512 });
    assert.equal(res.reclaimedPages, 0);
    assert.equal(res.freelistBefore, 0);
    assert.equal(res.freelistAfter, 0);
  } finally {
    db.close();
  }
});
