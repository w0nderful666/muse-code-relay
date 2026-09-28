const $ = id => document.getElementById(id);
const storage = {
  get(key) { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Current page still works without storage. */ } },
  remove(key) { try { sessionStorage.removeItem(key); } catch {} }
};
let claim = storage.get('relay.claim');
let currentReport = null;
let ackCredentials = null;
let turnstileIds = {};
let turnstileEnabled = false;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('服务暂时不可用，请稍后重试。'); }
  if (!payload.ok) throw new Error(payload.issue?.detail || '请求失败');
  return payload.result;
}
const post = (path, data) => api(path, { method: 'POST', body: JSON.stringify(data) });
function message(id, text, error = false) { $(id).textContent = text; $(id).classList.toggle('error', error); }
function tokenFor(action) { return turnstileEnabled ? window.turnstile?.getResponse(turnstileIds[action]) || '' : undefined; }
function resetChallenge(action) {
  if (turnstileEnabled && window.turnstile && turnstileIds[action] != null) window.turnstile.reset(turnstileIds[action]);
}
function saveFile(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const dateText = time => new Date(time).toLocaleString();

async function refreshMetrics() {
  const stats = await api('/api/overview');
  for (const [id, key] of Object.entries({ available: 'ready', 'today-claims': 'drawn_today', 'today-submitted': 'added_today',
    'total-copies': 'copies', 'total-milestones': 'milestones', 'total-positive': 'positive_reports' })) $(id).textContent = stats[key];
}
async function refresh() {
  await Promise.all([refreshMetrics(), (async () => {
    const list = await api('/api/board?limit=20');
    const parent = $('invite-list'); parent.replaceChildren();
    if (!list.entries.length) { parent.textContent = '清单暂时为空，欢迎分享第一个邀请码。'; return; }
    for (const [index, item] of list.entries.entries()) {
      const row = document.createElement('div'); row.className = 'invite-row';
      const serial = document.createElement('span'); serial.className = 'serial'; serial.textContent = String(index + 1).padStart(2, '0');
      const code = document.createElement('code'); code.textContent = item.preview;
      const state = document.createElement('span'); state.className = 'state'; state.textContent = '待领取';
      row.append(serial, code, state); parent.append(row);
    }
  })()]);
}
function refreshQuietly() { refresh().catch(() => {}); }
function initTurnstile(siteKey) {
  turnstileEnabled = true;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
  script.onload = () => {
    for (const [action, container] of [['submit', '#submit-turnstile'], ['claim', '#claim-turnstile']])
      turnstileIds[action] = window.turnstile.render(container, { sitekey: siteKey, action });
  };
  document.head.append(script);
  $('submit-turnstile').className = $('claim-turnstile').className = 'turnstile-space';
}
$('submit-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  const code = $('code').value.trim();
  message('submit-message', '正在提交…');
  try {
    await post('/api/share', { code, challenge_token: tokenFor('submit') });
    $('code').value = ''; $('lookup-code').value = code;
    message('submit-message', '已放入清单，可在下方直接输入邀请码查看接力进度。'); refreshQuietly();
  } catch (error) { message('submit-message', error.message, true); }
  finally { resetChallenge('submit'); button.disabled = false; }
});
function showClaim() {
  if (!claim) return;
  $('claimed-code').textContent = claim.code; $('claim-result').hidden = false;
  const canFeedback = Boolean(claim.confirmed) && !claim.feedbackSent;
  document.querySelectorAll('[data-feedback]').forEach(button => button.disabled = !canFeedback);
  $('feedback-hint').hidden = Boolean(claim.confirmed);
}

$('claim-button').addEventListener('click', async event => {
  const button = event.currentTarget; button.disabled = true; message('claim-message', '正在分配…');
  try {
    const data = await post('/api/draw', { challenge_token: tokenFor('claim') });
    claim = { ...data, confirmed: false, feedbackSent: false }; storage.set('relay.claim', claim); showClaim();
    message('claim-message', '领取成功，已记一次接力。点复制可把邀请码拷走，复制后才能反馈是否可用。'); refreshQuietly();
  } catch (error) { message('claim-message', error.message, true); }
  finally { resetChallenge('claim'); button.disabled = false; }
});
$('copy-button').addEventListener('click', async event => {
  const active = claim; if (!active) return;
  const button = event.currentTarget; button.disabled = true;
  try {
    try { await navigator.clipboard.writeText(active.code); }
    catch { message('claim-message', '自动复制失败，请手动选中邀请码。', true); return; }
    try {
      await post('/api/copy', { entry_id: active.entry_id, receipt: active.receipt });
      if (claim === active) {
        active.confirmed = true; storage.set('relay.claim', claim); showClaim();
        message('claim-message', '已复制。现在可以反馈这个码是否可用了。');
      }
      refreshQuietly();
    } catch { if (claim === active) message('claim-message', '已复制，但确认失败；可再次点击复制重试。', true); }
  } finally { button.disabled = false; }
});
document.querySelectorAll('[data-feedback]').forEach(button => button.addEventListener('click', async () => {
  const active = claim; if (!active || !active.confirmed || active.feedbackSent) return;
  document.querySelectorAll('[data-feedback]').forEach(x => x.disabled = true);
  try {
    await post('/api/report', { entry_id: active.entry_id, outcome: button.dataset.feedback, receipt: active.receipt });
    active.feedbackSent = true;
    if (claim === active) { storage.set('relay.claim', claim); message('claim-message', '反馈已记录，谢谢。'); }
    refreshQuietly();
  } catch (error) {
    if (claim === active) { message('claim-message', error.message, true); document.querySelectorAll('[data-feedback]').forEach(x => x.disabled = false); }
  }
}));
function renderReport(report) {
  $('progress-result').hidden = false; $('progress-kind').textContent = report.final ? '30 次复制里程碑 / 最终成绩单' : '我的接力 / 今日进度';
  $('progress-preview').textContent = report.preview; $('progress-copies').textContent = report.copies;
  $('progress-bar').value = Math.min(report.copies, 30);
  $('progress-details').textContent = `截至记录时：${report.positive_reports} 次有效反馈，${report.negative_reports} 次无效反馈。复制按邀请码与匿名网络来源去重，不等同实际注册人数。`;
  $('progress-timing').textContent = `记录时间：${dateText(report.as_of)}。${report.final ? '请保存这份成绩单，清理后无法再次查询。' : '数据实时更新，每次查询都是最新。'}`;
  $('deletion-status').textContent = ''; $('retry-delete').hidden = true;
}
async function acknowledgeReport() {
  if (!ackCredentials) return;
  $('retry-delete').disabled = true;
  try {
    await post('/api/progress/ack', ackCredentials);
    $('deletion-status').textContent = '该邀请码和领取明细已从业务数据库清理。匿名累计数字会继续保留。';
    $('retry-delete').hidden = true; ackCredentials = null;
    refreshQuietly();
  } catch {
    $('deletion-status').textContent = '成绩单已显示，清理请求暂未确认。可以重试；到期也会自动清理。'; $('retry-delete').hidden = false;
  } finally { $('retry-delete').disabled = false; }
}
$('progress-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  const credentials = { code: $('lookup-code').value.trim() };
  message('progress-message', '正在读取…');
  try {
    currentReport = await post('/api/progress', credentials); renderReport(currentReport); message('progress-message', '');
    $('progress-result').scrollIntoView({ behavior: 'instant', block: 'center' });
    if (currentReport.final) {
      ackCredentials = credentials;
      // Let the result paint before confirming destructive cleanup to the server.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await acknowledgeReport();
    }
  } catch (error) { message('progress-message', `${error.message} 已查看或到期的成绩单无法再次查询。`, true); }
  finally { button.disabled = false; }
});
$('retry-delete').addEventListener('click', acknowledgeReport);
$('save-report').addEventListener('click', () => {
  if (!currentReport) return;
  const r = currentReport;
  saveFile('下一位-接力成绩单.txt', `下一位 · ${r.final ? '最终成绩单' : '今日进度'}\n记录时间：${dateText(r.as_of)}\n邀请码掩码：${r.preview}\n去重复制：${r.copies} / ${r.target}\n有效反馈：${r.positive_reports}\n无效反馈：${r.negative_reports}\n\n复制不等同真实注册或平台任务完成。\n`);
});

(async () => {
  if (claim && typeof claim.code === 'string' && typeof claim.receipt === 'string') showClaim(); else claim = null;
  try {
    const config = await api('/api/settings'); $('retention-hours').textContent = config.retention_hours;
    if (config.challenge_key) initTurnstile(config.challenge_key);
    await refresh();
  } catch (error) { $('invite-list').textContent = '暂时无法读取清单。'; message('claim-message', error.message, true); }
})();
