import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

// Execute the production SQL and triggers against SQLite. Only the D1 transport is adapted.
function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of ['0001_init.sql', '0002_relay_metrics.sql', '0003_progress_queries.sql', '0004_pause_threshold.sql', '0005_draw_counts_as_copy.sql', '0006_pause_threshold_5.sql']) sqlite.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const prepare = (sql, values = []) => ({
    bind(...args) { return prepare(sql, args); },
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    runSync() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
    async run() { return this.runSync(); }
  });
  const env = {
    HASH_SECRET: 'testing-hash-secret-32-characters-minimum', ADMIN_TOKEN: 'testing-admin-secret-32-characters-minimum',
    DRAW_CAP_PER_CODE: '60', COMPLETED_RETENTION_HOURS: '48',
    DB: { prepare, async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = statements.map(s => s.runSync()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } }
  };
  async function api(path, data, actor = 'owner') {
    const request = new Request(`https://relay.test${path}`, { method: data ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': actor }, ...(data ? { body: JSON.stringify(data) } : {}) });
    const response = await worker.fetch(request, env);
    return { status: response.status, ...(await response.json()) };
  }
  async function share(code = 'aBc123', actor = 'owner') {
    const response = await api('/api/share', { code }, actor); assert.equal(response.status, 201); return response.result.id;
  }
  async function draw(id, actor) {
    const response = await api('/api/draw', { entry_id: id }, actor); assert.equal(response.status, 200, JSON.stringify(response)); return response.result;
  }
  async function copy(draw, actor) { return api('/api/copy', { entry_id: draw.entry_id, receipt: draw.receipt }, actor); }
  return { sqlite, env, api, share, draw, copy };
}

test('preserves code case; duplicates rejected; submitter may draw their own entry', async () => {
  const t = setup(); await t.share();
  assert.equal(t.sqlite.prepare('SELECT code FROM invites').get().code, 'aBc123');
  assert.equal((await t.api('/api/share', { code: 'aBc123' }, 'other')).status, 409);
  assert.equal((await t.api('/api/share', { code: 'abc' })).status, 400);
  assert.equal((await t.api('/api/progress', { code: 'zzZ999' })).status, 403);
  const own = await t.draw(undefined, 'owner');
  assert.equal(own.code, 'aBc123');
  assert.equal((await t.api('/api/draw', {}, 'owner')).status, 404, 'Same actor cannot draw the same code twice');
  assert.equal((await t.api('/api/board')).result.entries[0].preview, 'aB****');
});

test('draw counts as a copy; feedback requires copy-button confirmation', async () => {
  const t = setup(); const id = await t.share();
  const claim = await t.draw(id, 'reader-1'); assert.equal(claim.code, 'aBc123');
  assert.equal((await t.api('/api/progress', { code: 'aBc123' })).result.copies, 1, 'Draw counts as a copy immediately');
  assert.equal((await t.api('/api/report', { entry_id: id, receipt: claim.receipt, outcome: 'success' }, 'reader-1')).status, 409,
    'Feedback before confirming copy is rejected');
  assert.equal((await t.copy(claim, 'someone-else')).status, 403, 'Forged confirmations are rejected');
  assert.equal((await t.copy(claim, 'reader-1')).result.confirmed, true);
  assert.equal((await t.copy(claim, 'reader-1')).result.confirmed, true, 'Confirming twice is idempotent');
  assert.equal((await t.api('/api/report', { entry_id: id, receipt: claim.receipt, outcome: 'success' }, 'reader-1')).status, 200);
  assert.equal((await t.api('/api/report', { entry_id: id, receipt: claim.receipt, outcome: 'success' }, 'reader-1')).status, 409,
    'Feedback stays one vote per draw');
  assert.equal((await t.api('/api/draw', { entry_id: id }, 'reader-1')).status, 404, 'Same actor cannot draw the same code twice');
  const live = await t.api('/api/progress', { code: 'aBc123' });
  assert.equal(live.result.copies, 1); assert.equal(live.result.positive_reports, 1);
});

test('auto-pause needs five failure reports; paused codes stop being drawn', async () => {
  const t = setup(); const id = await t.share();
  for (const actor of ['voter-a', 'voter-b', 'voter-c', 'voter-d', 'voter-e']) {
    const claim = await t.draw(id, actor);
    assert.equal((await t.copy(claim, actor)).result.confirmed, true);
    assert.equal((await t.api('/api/report', { entry_id: id, receipt: claim.receipt, outcome: 'failure' }, actor)).status, 200);
    const row = t.sqlite.prepare('SELECT status,failure_count FROM invites WHERE id=?').get(id);
    if (actor === 'voter-e') { assert.equal(row.status, 'PAUSED'); assert.equal(row.failure_count, 5); }
    else assert.equal(row.status, 'ACTIVE', 'Fewer than five failure reports must not pause the code');
  }
  assert.equal((await t.api('/api/draw', {}, 'latecomer')).status, 404, 'Paused codes are not drawn');
});

test('30th draw completes the milestone; further draws stop; view and ack erase details while keeping totals and quotas', async () => {
  const t = setup(); const id = await t.share();
  for (let i = 0; i < 29; i++) await t.draw(id, `reader-${i}`);
  const race = await Promise.all([t.api('/api/draw', { entry_id: id }, 'racer-a'), t.api('/api/draw', { entry_id: id }, 'racer-b')]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 404], 'Only one draw can take the 30th copy');
  assert.equal(t.sqlite.prepare('SELECT copy_count FROM invites WHERE id=?').get(id).copy_count, 30);
  assert.equal((await t.api('/api/draw', { entry_id: id }, 'extra-reader')).status, 404);
  const before = (await t.api('/api/overview')).result;
  assert.equal(before.copies, 30); assert.equal(before.milestones, 1); assert.equal(before.ready, 0);
  const report = (await t.api('/api/progress', { code: 'aBc123' })).result;
  assert.equal(report.final, true); assert.equal(report.copies, 30);
  assert.equal(t.sqlite.prepare('SELECT COUNT(*) n FROM claims').get().n, 30, 'Do not delete until display acknowledgement');
  assert.equal((await t.api('/api/progress/ack', { code: 'aBc123' })).status, 200);
  assert.equal((await t.api('/api/progress/ack', { code: 'aBc123' })).status, 200, 'Acknowledgement is safely retryable');
  assert.equal(t.sqlite.prepare('SELECT COUNT(*) n FROM invites').get().n, 0);
  assert.equal(t.sqlite.prepare('SELECT COUNT(*) n FROM claims').get().n, 0);
  assert.equal(t.sqlite.prepare('SELECT SUM(draws) n FROM daily_quota').get().n, 30);
  const after = (await t.api('/api/overview')).result;
  assert.equal(after.copies, 30); assert.equal(after.milestones, 1); assert.equal(after.drawn_today, before.drawn_today);
  assert.equal((await t.api('/api/progress', { code: 'aBc123' })).status, 403);
});

test('scheduled expiry deletes completed detail, preserves active entries, and never forgets historical totals', async () => {
  const t = setup(); const id = await t.share(); await t.share('Active', 'other-owner');
  for (let i = 0; i < 30; i++) await t.copy(await t.draw(id, `reader-${i}`), `reader-${i}`);
  await worker.scheduled({ scheduledTime: Date.now()+49*3_600_000 }, t.env);
  assert.equal(t.sqlite.prepare('SELECT COUNT(*) n FROM invites WHERE id=?').get(id).n, 0);
  assert.equal(t.sqlite.prepare('SELECT COUNT(*) n FROM claims').get().n, 0);
  assert.equal(t.sqlite.prepare('SELECT code FROM invites').get().code, 'Active');
  assert.equal(t.sqlite.prepare('SELECT COUNT(*) n FROM daily_quota').get().n, 0);
  assert.equal((await t.api('/api/overview')).result.copies, 30);
  assert.equal((await t.api('/api/overview')).result.milestones, 1);
});

test('progress queries are capped at three per actor per day', async () => {
  const t = setup(); await t.share();
  for (let i = 0; i < 3; i++) assert.equal((await t.api('/api/progress', { code: 'aBc123' }, 'curious')).status, 200);
  const limited = await t.api('/api/progress', { code: 'aBc123' }, 'curious');
  assert.equal(limited.status, 429);
  assert.equal(limited.issue.type, 'RATE_LIMIT');
  assert.equal((await t.api('/api/progress', { code: 'aBc123' }, 'someone-else')).status, 200);
});

test('daily claim cap survives deletion; native rate-limit rejections avoid database access', async () => {
  const t = setup();
  for (let i = 0; i < 4; i++) {
    const id = await t.share(`TEST0${i}`, 'owner');
    if (i < 3) await t.draw(id, 'one-reader');
    else assert.equal((await t.api('/api/draw', { entry_id: id }, 'one-reader')).status, 429);
  }
  t.sqlite.exec('DELETE FROM invites WHERE id<=3');
  assert.equal((await t.api('/api/draw', {}, 'one-reader')).status, 429);
  t.env.API_LIMIT = { limit: async () => ({ success: false }) };
  t.env.DB = { prepare: () => { throw new Error('Must not reach database'); } };
  assert.equal((await t.api('/api/overview')).status, 429);
});
