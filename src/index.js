const PLATFORM = { id: 'muse', name: 'Muse', description: 'Muse 邀请码' };
const MAX_DAILY_CLAIMS = 3;
const MAX_DAILY_SUBMISSIONS = 5;
const MAX_DAILY_QUERIES = 3;
const COPY_MILESTONE = 30; // Kept in sync with migration 0002's one-time milestone trigger.
const DAY = 86_400_000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers }
  });
}
const ok = result => json({ ok: true, result });
const fail = (type, detail, status = 400, headers = {}) => json({ ok: false, issue: { type, detail } }, status, headers);

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}
async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), x => x.toString(16).padStart(2, '0')).join('');
}
async function sameToken(a, b) {
  if (!a || !b) return false;
  return (await digest(a)) === (await digest(b));
}
function mask(code) { return code.slice(0, 2) + '****'; }
async function body(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Error('JSON_REQUIRED');
  if (!request.body) throw new Error('JSON_REQUIRED');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 4096) { await reader.cancel(); throw new Error('TOO_LARGE'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON_REQUIRED');
  return value;
}
function utcDayStart(now) { return Math.floor(now / DAY) * DAY; }
function retentionMs(env) { return (env.COMPLETED_RETENTION_HOURS === '24' ? 24 : 48) * 3_600_000; }
function normalizeCode(value) { return typeof value === 'string' ? value.trim() : ''; }
function validReceipt(input) {
  return Number.isSafeInteger(input.entry_id) && input.entry_id > 0 && typeof input.receipt === 'string' && input.receipt.length === 72;
}

async function verifyTurnstile(request, env, token, action) {
  if (!env.TURNSTILE_SITE_KEY && !env.TURNSTILE_SECRET_KEY) return true;
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY || typeof token !== 'string' || token.length > 2048 || !token) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.set('remoteip', ip);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    const result = await response.json();
    const host = new URL(request.url).hostname;
    return result.success === true && result.action === action && result.hostname === host;
  } catch { return false; }
}

async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const drawCap = Math.min(1000, Math.max(1, Number.parseInt(env.DRAW_CAP_PER_CODE || '60', 10) || 60));
  if (!env.DB || !env.HASH_SECRET || !env.ADMIN_TOKEN || env.HASH_SECRET.length < 24 || env.ADMIN_TOKEN.length < 24)
    return fail('SETUP_REQUIRED', '请先配置 D1 和两个长度至少 24 字符的密钥。', 503);

  if (method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return fail('ORIGIN_FORBIDDEN', '请求来源不被允许。', 403);
    if (Number(request.headers.get('content-length') || 0) > 4096) return fail('TOO_LARGE', '请求内容过长。', 413);
  }

  const actor = await hmac(env.HASH_SECRET, 'ip:' + (request.headers.get('CF-Connecting-IP') || 'local-dev'));
  if (env.API_LIMIT && !(await env.API_LIMIT.limit({ key: actor })).success)
    return fail('TOO_FAST', '操作太频繁，请一分钟后再试。', 429, { 'retry-after': '60' });
  if (path === '/api/progress' && env.LOOKUP_LIMIT && !(await env.LOOKUP_LIMIT.limit({ key: actor })).success)
    return fail('TOO_FAST', '查询太频繁，请一分钟后再试。', 429, { 'retry-after': '60' });

  if (method === 'GET' && path === '/api/settings')
    return ok({ product: PLATFORM.name, challenge_key: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null,
      max_daily_claims: MAX_DAILY_CLAIMS, max_daily_queries: MAX_DAILY_QUERIES, max_claims_per_code: drawCap, copy_milestone: COPY_MILESTONE,
      retention_hours: retentionMs(env) / 3_600_000 });

  if (method === 'GET' && path === '/api/overview') {
    const now = Date.now();
    const row = await env.DB.prepare(`SELECT
      (SELECT COUNT(*) FROM invites i WHERE i.platform=?1 AND i.status='ACTIVE' AND i.claim_count<${drawCap} AND i.milestone_at IS NULL) available_count,
      (SELECT COUNT(*) FROM invites WHERE platform=?1 AND status!='REMOVED') total_count,
      COALESCE((SELECT draws FROM relay_daily WHERE day=?2),0) today_claims,
      COALESCE((SELECT submissions FROM relay_daily WHERE day=?2),0) today_submitted,
      copies,milestones,positive_reports FROM relay_totals WHERE id=1`).bind(PLATFORM.id, utcDayStart(now)).first();
    return ok({ ready: row.available_count, stored_total: row.total_count, drawn_today: row.today_claims, added_today: row.today_submitted,
      copies: row.copies, milestones: row.milestones, positive_reports: row.positive_reports });
  }

  if (method === 'GET' && path === '/api/board') {
    const limit = Math.min(30, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '12', 10) || 12));
    const rows = await env.DB.prepare(`SELECT i.id,i.platform,i.code,i.status,i.success_count,i.failure_count,i.last_verified_at
      FROM invites i WHERE i.platform=?1 AND i.status='ACTIVE'
      AND i.claim_count<${drawCap} AND i.milestone_at IS NULL
      ORDER BY i.success_count DESC, i.failure_count ASC, i.created_at ASC LIMIT ?2`).bind(PLATFORM.id, limit).all();
    return ok({ entries: rows.results.map(row => ({ id: row.id, preview: mask(row.code) })) });
  }

  if (method === 'POST' && path === '/api/share') {
    const input = await body(request);
    const code = normalizeCode(input.code);
    if (!/^[A-Za-z0-9]{6}$/.test(code)) return fail('BAD_CODE', '邀请码须为 6 位字母或数字。');
    if (!await verifyTurnstile(request, env, input.challenge_token, 'submit')) return fail('HUMAN_CHECK', '人机验证失败，请重试。', 403);
    const now = Date.now();
    const codeHash = await hmac(env.HASH_SECRET, 'code:' + PLATFORM.id + ':' + code);
    const result = await env.DB.prepare(`INSERT OR IGNORE INTO invites(platform,code,code_hash,submitted_by,created_at)
      SELECT ?1,?2,?3,?4,?5 WHERE COALESCE((SELECT submissions FROM daily_quota WHERE actor_hash=?4 AND day=?6),0)<${MAX_DAILY_SUBMISSIONS}
      RETURNING id`).bind(PLATFORM.id, code, codeHash, actor, now, utcDayStart(now)).first();
    if (!result) {
      const duplicate = await env.DB.prepare('SELECT id FROM invites WHERE code_hash=?').bind(codeHash).first();
      return duplicate ? fail('DUPLICATE', '这个邀请码已在池中。', 409) : fail('RATE_LIMIT', '今天提交次数已用完。', 429, { 'retry-after': '3600' });
    }
    return json({ ok: true, result: { id: result.id, preview: mask(code) } }, 201);
  }

  if (method === 'POST' && path === '/api/draw') {
    const input = await body(request);
    if (!await verifyTurnstile(request, env, input.challenge_token, 'claim')) return fail('HUMAN_CHECK', '人机验证失败，请重试。', 403);
    const now = Date.now();
    const id = crypto.randomUUID();
    const receipt = crypto.randomUUID() + crypto.randomUUID();
    const receiptHash = await digest(receipt);
    const preferred = Number.isSafeInteger(input.entry_id) && input.entry_id > 0 ? input.entry_id : null;
    const row = await env.DB.prepare(`INSERT OR IGNORE INTO claims(id,invite_id,actor_hash,receipt_hash,created_at,copied_at)
      SELECT ?1,i.id,?2,?3,?4,?4 FROM invites i
      WHERE i.platform=?5 AND i.status='ACTIVE' AND (?6 IS NULL OR i.id=?6)
      AND COALESCE((SELECT draws FROM daily_quota WHERE actor_hash=?2 AND day=?7),0)<${MAX_DAILY_CLAIMS}
      AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.invite_id=i.id AND c.actor_hash=?2)
      AND i.claim_count<${drawCap} AND i.milestone_at IS NULL AND i.copy_count<${COPY_MILESTONE}
      ORDER BY i.success_count DESC, i.failure_count ASC, random() LIMIT 1
      RETURNING invite_id,(SELECT code FROM invites WHERE id=claims.invite_id) AS code`).bind(id, actor, receiptHash, now, PLATFORM.id, preferred, utcDayStart(now)).first();
    if (!row) {
      const count = await env.DB.prepare('SELECT draws FROM daily_quota WHERE actor_hash=? AND day=?').bind(actor, utcDayStart(now)).first();
      return (count?.draws || 0) >= MAX_DAILY_CLAIMS ? fail('RATE_LIMIT', '今天领取次数已用完。', 429, { 'retry-after': '3600' }) : fail('NO_INVITE', '暂时没有适合你的邀请码，请稍后再试。', 404);
    }
    return ok({ entry_id: row.invite_id, code: row.code, receipt });
  }

  if (method === 'POST' && path === '/api/copy') {
    // "Confirm copy": the draw already counted the copy. Clicking the copy
    // button proves the user really took the code and unlocks feedback.
    const input = await body(request);
    if (!validReceipt(input)) return fail('BAD_RECEIPT', '领取凭据格式不正确。');
    const receiptHash = await digest(input.receipt);
    const claim = await env.DB.prepare(`UPDATE claims SET confirmed_at=?1
      WHERE invite_id=?2 AND receipt_hash=?3 AND actor_hash=?4 AND copied_at IS NOT NULL
      RETURNING confirmed_at`).bind(Date.now(), input.entry_id, receiptHash, actor).first();
    if (!claim) return fail('BAD_RECEIPT', '领取凭据无效。', 403);
    return ok({ confirmed: true });
  }

  if (method === 'POST' && path === '/api/progress') {
    const input = await body(request);
    const code = normalizeCode(input.code);
    if (!/^[A-Za-z0-9]{6}$/.test(code)) return fail('BAD_CREDENTIAL', '请输入正确的邀请码。', 403);
    const codeHash = await hmac(env.HASH_SECRET, 'code:' + PLATFORM.id + ':' + code);
    const now = Date.now();
    const day = utcDayStart(now);
    const used = await env.DB.prepare('SELECT COALESCE(queries,0) AS q FROM daily_quota WHERE day=? AND actor_hash=?')
      .bind(day, actor).first();
    if (used && used.q >= MAX_DAILY_QUERIES) return fail('RATE_LIMIT', '今天查询次数已用完。', 429, { 'retry-after': '3600' });
    const row = await env.DB.prepare(`SELECT id,milestone_at,snapshot_at,snapshot_copies,snapshot_successes,snapshot_failures,snapshot_final
      FROM invites WHERE code_hash=?`).bind(codeHash).first();
    if (!row) return fail('BAD_CREDENTIAL', '邀请码不存在。', 403);
    if (row.milestone_at !== null && row.milestone_at + retentionMs(env) <= now) {
      await env.DB.prepare('DELETE FROM invites WHERE id=? AND milestone_at<=?').bind(row.id, now-retentionMs(env)).run();
      return fail('EXPIRED', '这份成绩单已到期，相关邀请码和明细已清理。', 410);
    }
    if (!row.snapshot_final) {
      // Progress is live: every query refreshes the snapshot so submitters
      // immediately see copies and feedback recorded after their last visit.
      await env.DB.prepare(`UPDATE invites SET snapshot_at=?1,snapshot_copies=copy_count,
        snapshot_successes=success_count,snapshot_failures=failure_count
        WHERE id=?2 AND snapshot_final=0`)
        .bind(now, row.id).run();
    }
    const snapshot = await env.DB.prepare(`SELECT snapshot_at,snapshot_copies,snapshot_successes,snapshot_failures,snapshot_final
      FROM invites WHERE id=?`).bind(row.id).first();
    if (!snapshot) return fail('EXPIRED', '这份成绩单已查看或到期，相关数据已清理。', 410);
    await env.DB.prepare('INSERT INTO daily_quota(day,actor_hash,queries) VALUES(?,?,1) ON CONFLICT(day,actor_hash) DO UPDATE SET queries=queries+1')
      .bind(day, actor).run();
    return ok({ preview: mask(code), copies: snapshot.snapshot_copies, positive_reports: snapshot.snapshot_successes,
      negative_reports: snapshot.snapshot_failures, target: COPY_MILESTONE, final: Boolean(snapshot.snapshot_final),
      as_of: snapshot.snapshot_at, next_refresh_at: snapshot.snapshot_final ? null : snapshot.snapshot_at + DAY,
      expires_at: snapshot.snapshot_final ? snapshot.snapshot_at + retentionMs(env) : null });
  }

  if (method === 'POST' && path === '/api/progress/ack') {
    const input = await body(request);
    const code = normalizeCode(input.code);
    if (!/^[A-Za-z0-9]{6}$/.test(code)) return fail('BAD_CREDENTIAL', '邀请码格式不正确。', 403);
    const codeHash = await hmac(env.HASH_SECRET, 'code:' + PLATFORM.id + ':' + code);
    // Idempotent ack: if the response is lost, retrying never deletes other entries.
    await env.DB.prepare('DELETE FROM invites WHERE code_hash=? AND milestone_at IS NOT NULL')
      .bind(codeHash).run();
    return ok({ deleted: true });
  }

  if (method === 'POST' && path === '/api/report') {
    const input = await body(request);
    if (!['success', 'failure'].includes(input.outcome) || !validReceipt(input)) return fail('BAD_FEEDBACK', '反馈格式错误。');
    const receiptHash = await digest(input.receipt);
    const now = Date.now();
    const updated = await env.DB.prepare(`UPDATE claims SET feedback=?1,feedback_at=?2
      WHERE invite_id=?3 AND receipt_hash=?4 AND actor_hash=?5 AND feedback IS NULL AND confirmed_at IS NOT NULL RETURNING invite_id`)
      .bind(input.outcome, now, input.entry_id, receiptHash, actor).first();
    if (!updated) return fail('FEEDBACK_UNAVAILABLE', '请先点击复制按钮，再提交反馈；反馈凭据无效或已经提交过。', 409);
    return ok({ recorded: true });
  }

  if (path.startsWith('/api/desk/')) {
    if (!await sameToken(request.headers.get('x-admin-token'), env.ADMIN_TOKEN)) return fail('UNAUTHORIZED', '管理令牌无效。', 401);
    if (method === 'GET' && path === '/api/desk/summary') {
      const row = await env.DB.prepare(`SELECT
        (SELECT COUNT(*) FROM invites) total,
        (SELECT COUNT(*) FROM invites WHERE status='ACTIVE') active,
        (SELECT COUNT(*) FROM invites WHERE status='PAUSED') paused,
        draws claims,
        copies,milestones,positive_reports FROM relay_totals WHERE id=1`).first();
      return ok(row);
    }
    if (method === 'GET' && path === '/api/desk/codes') {
      const status = url.searchParams.get('status');
      if (status && !['ACTIVE','PAUSED','REMOVED'].includes(status)) return fail('BAD_STATUS', '状态无效。');
      const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '30', 10) || 30));
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
      const rows = await env.DB.prepare(`SELECT i.id,i.platform,i.code,i.status,i.created_at,i.success_count,i.failure_count,
        i.claim_count,i.copy_count,i.milestone_at FROM invites i
        WHERE (?1 IS NULL OR i.status=?1) ORDER BY i.created_at DESC LIMIT ?2 OFFSET ?3`).bind(status, limit, offset).all();
      return ok({ items: rows.results, limit, offset });
    }
    const statusMatch = path.match(/^\/api\/desk\/codes\/(\d+)$/);
    if (method === 'POST' && statusMatch) {
      const input = await body(request);
      if (!['ACTIVE','PAUSED','REMOVED'].includes(input.status)) return fail('BAD_STATUS', '状态无效。');
      const row = await env.DB.prepare('UPDATE invites SET status=? WHERE id=? RETURNING id,status').bind(input.status, Number(statusMatch[1])).first();
      return row ? ok(row) : fail('NOT_FOUND', '邀请码不存在。', 404);
    }
  }
  return fail('NOT_FOUND', '接口不存在。', 404);
}

export default {
  async scheduled(controller, env) {
    const now = controller.scheduledTime;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM invites WHERE milestone_at IS NOT NULL AND milestone_at<=?').bind(now-retentionMs(env)),
      env.DB.prepare('DELETE FROM daily_quota WHERE day<?').bind(utcDayStart(now)),
      env.DB.prepare('DELETE FROM relay_daily WHERE day<?').bind(utcDayStart(now)-31*DAY)
    ]);
  },
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
      return await handle(request, env);
    } catch (error) {
      if (error.message === 'JSON_REQUIRED' || error instanceof SyntaxError) return fail('BAD_JSON', '请发送 JSON 对象。');
      if (error.message === 'TOO_LARGE') return fail('TOO_LARGE', '请求内容过长。', 413);
      console.error('Request failed:', error.name);
      return fail('INTERNAL_ERROR', '服务暂时不可用。', 500);
    }
  }
};
