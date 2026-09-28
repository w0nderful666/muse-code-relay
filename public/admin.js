const $ = id => document.getElementById(id);
let adminToken = '';
let offset = 0;
const pageSize = 30;

async function adminApi(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'x-admin-token': adminToken, 'content-type': 'application/json' } });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.issue?.detail || '请求失败');
  return payload.result;
}
function report(text, error = false) {
  $('admin-message').textContent = text;
  $('admin-message').classList.toggle('error', error);
}
async function refreshStats() {
  const data = await adminApi('/api/desk/summary');
  for (const key of ['total', 'active', 'paused', 'claims']) $(key).textContent = data[key];
  let summary = document.getElementById('admin-relay-summary');
  if (!summary) { summary = document.createElement('p'); summary.id = 'admin-relay-summary'; document.querySelector('.admin-list-section').prepend(summary); }
  summary.textContent = `匿名累计：${data.copies} 次去重复制 · ${data.milestones} 轮 30 次达标 · ${data.positive_reports} 次有效反馈。已清理的码不再出现在下方清单。`;
}
function row(item) {
  const el = document.createElement('div');
  el.className = 'admin-row';
  const id = document.createElement('strong'); id.textContent = `#${item.id}`;
  const info = document.createElement('div');
  const code = document.createElement('code'); code.textContent = item.code;
  const details = document.createElement('small'); details.textContent = `领取 ${item.claim_count} · 去重复制 ${item.copy_count}/30 · 有效 ${item.success_count} · 无效 ${item.failure_count}${item.milestone_at ? ' · 已达标，待清理' : ''} · ${new Date(item.created_at).toLocaleString()}`;
  info.append(code, details);
  const controls = document.createElement('div'); controls.className = 'controls';
  const select = document.createElement('select'); select.setAttribute('aria-label', `邀请码 ${item.id} 状态`);
  for (const status of ['ACTIVE', 'PAUSED', 'REMOVED']) {
    const option = document.createElement('option'); option.value = option.textContent = status; select.append(option);
  }
  select.value = item.status;
  const save = document.createElement('button'); save.className = 'small'; save.textContent = '保存';
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { await adminApi(`/api/desk/codes/${item.id}`, { method: 'POST', body: JSON.stringify({ status: select.value }) }); report(`#${item.id} 已更新为 ${select.value}`); await refreshStats(); }
    catch (error) { report(error.message, true); }
    finally { save.disabled = false; }
  });
  controls.append(select, save); el.append(id, info, controls); return el;
}
async function load(reset = false) {
  if (reset) { offset = 0; $('admin-list').replaceChildren(); }
  const status = $('status-filter').value;
  const data = await adminApi(`/api/desk/codes?limit=${pageSize}&offset=${offset}${status ? `&status=${encodeURIComponent(status)}` : ''}`);
  for (const item of data.items) $('admin-list').append(row(item));
  offset += data.items.length;
  $('more-button').hidden = data.items.length < pageSize;
  if (reset && !data.items.length) $('admin-list').textContent = '没有匹配的邀请码。';
}
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault(); adminToken = $('token').value; $('token').value = '';
  try { await refreshStats(); await load(true); $('admin-content').hidden = false; report(''); }
  catch (error) { $('admin-content').hidden = true; report(error.message, true); }
});
$('status-filter').addEventListener('change', () => load(true).catch(error => report(error.message, true)));
$('more-button').addEventListener('click', () => load().catch(error => report(error.message, true)));
