const $ = selector => document.querySelector(selector);
const number = value => Number(value || 0).toLocaleString();
const hours = value => `${(Number(value || 0) / 3_600_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
let lastSummary = null;
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function showLogin(message = '') {
  lastSummary = null;
  for (const form of ['#change-password', '#security-action']) $(form)?.reset();
  $('#recovery-codes').value = ''; $('#recovery-result').hidden = true;
  $('#owner-sessions').replaceChildren(); $('#reports').replaceChildren();
  $('#dashboard').hidden = true; $('#logout').hidden = true; $('#login-panel').hidden = false;
  $('#daily').replaceChildren(); $('#platforms').replaceChildren();
  for (const selector of ['#live-cards', '#lifetime-cards', '#period-cards', '#insights']) $(selector).replaceChildren();
  $('#status').textContent = message;
}
async function api(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin('Your session expired. Sign in again.'); throw new Error(result.error || 'Request failed.'); }
  return result;
}
function cards(selector, values) {
  $(selector).replaceChildren(...values.map(([label, value]) => { const card = text('article', ''); card.className = 'card'; card.append(text('p', label), text('strong', value)); return card; }));
}
async function refresh() {
  $('#refresh').disabled = true; $('#status').textContent = 'Loading statistics…';
  try {
    const data = await api(`/api/admin/analytics?days=${$('#period').value}`);
    lastSummary = data;
    $('#login-panel').hidden = true; $('#dashboard').hidden = false; $('#logout').hidden = false;
    cards('#live-cards', [['Devices online', number(data.live.users)], ['Room connections', number(data.live.sessions)], ['Active rooms', number(data.live.rooms)], ['Live sources', number(data.live.streams)]]);
    cards('#lifetime-cards', [['Unique devices', number(data.lifetime.users)], ['Total room time', hours(data.lifetime.onlineMs)], ['Total listening time', hours(data.lifetime.listeningMs)], ['Rooms created', number(data.lifetime.roomsCreated)]]);
    cards('#period-cards', [['Devices', number(data.totals.users)], ['Room time', hours(data.totals.onlineMs)], ['Listening time', hours(data.totals.listeningMs)], ['Joins (incl. reconnects)', number(data.totals.sessions)], ['Reconnects', number(data.totals.reconnects)], ['Relay backlog drops', number(data.totals.dropped)]]);
    $('#daily').replaceChildren(...data.daily.map(row => { const tr = document.createElement('tr'); for (const value of [row.day, number(row.users), hours(row.onlineMs), hours(row.listeningMs), number(row.sessions), number(row.roomsCreated)]) tr.append(text('td', value)); return tr; }));
    if (!data.daily.length) { const row = document.createElement('tr'); const cell = text('td', 'No activity recorded in this period yet.'); cell.colSpan = 6; row.append(cell); $('#daily').append(row); }
    $('#platforms').replaceChildren(...data.platforms.map(row => { const div = text('div', `${row.platform}: ${number(row.users)} devices · ${hours(row.listeningMs)} listening`); div.className = 'platform'; return div; }));
    const insights = [];
    if (data.analytics?.discardedRows) insights.push('Some statistics were discarded during a prolonged outage or capacity limit. These totals are incomplete.');
    if (data.totals.dropped) insights.push(`${number(data.totals.dropped)} relay packets skipped because a listener's network queue was full. Check listener connections and stream-health reports.`);
    if (data.totals.reconnects) insights.push(`${number(data.totals.reconnects)} reconnections recorded. Compare these with device diagnostics before changing audio settings.`);
    if (!data.durable) insights.push('Development mode: these totals are stored in memory and reset when the server restarts.');
    if (!insights.length) insights.push('No relay backlog drops or reconnections recorded in this period. This does not measure audible quality.');
    $('#insights').replaceChildren(...insights.map(value => text('li', value)));
    $('#updated').textContent = `Updated ${new Date(data.updatedAt).toLocaleString()} · v${data.live.version}`;
    $('#status').textContent = '';
  } catch (error) { $('#status').textContent = error.message; }
  finally { $('#refresh').disabled = false; }
}
$('#login').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); button.disabled = true;
  const credentials = Object.fromEntries(new FormData(form));
  try { await api('/api/admin/login', credentials); form.reset(); await refresh(); }
  catch (error) { $('#status').textContent = error.message; }
  finally { form.elements.password.value = ''; form.elements.code.value = ''; button.disabled = false; }
});
$('#logout').addEventListener('click', async () => {
  try { await api('/api/admin/logout', {}); showLogin('Signed out.'); }
  catch (error) { $('#status').textContent = error.message; }
});
$('#refresh').addEventListener('click', refresh);
$('#period').addEventListener('change', refresh);
try { await api('/api/admin/session'); await refresh(); }
catch (error) { showLogin(error.message === 'Owner sign-in required.' ? '' : error.message); }
// Clear private data when restoring a cached page; the server rechecks the role.
window.addEventListener('pageshow', event => { if (event.persisted) { showLogin(); api('/api/admin/session').then(refresh).catch(() => {}); } });

for (const [selector, endpoint] of [['#change-password', 'password'], ['#security-action', null]]) {
  $(selector).addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button');
    const values = Object.fromEntries(new FormData(form));
    if (endpoint === 'password' && values.newPassword !== values.confirmPassword) { $('#status').textContent = 'The new passwords do not match.'; return; }
    button.disabled = true; $('#status').textContent = 'Applying security change.';
    try {
      const result = await api(`/api/admin/${endpoint || values.action}`, values);
      form.reset();
      if (result.signedOut) showLogin('Security change saved. Sign in again. Generate new recovery codes after a password change.');
      else if (result.codes) {
        $('#recovery-codes').value = result.codes.join('\n'); $('#recovery-result').hidden = false;
        $('#status').textContent = 'New recovery codes are shown once below. Save them privately.';
      }
    } catch (error) { $('#status').textContent = error.message; }
    finally { for (const field of form.querySelectorAll('input')) field.value = ''; button.disabled = false; }
  });
}
$('#clear-recovery').addEventListener('click', () => { $('#recovery-codes').value = ''; $('#recovery-result').hidden = true; });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { $('#recovery-codes').value = ''; $('#recovery-result').hidden = true; }
});
$('#show-sessions').addEventListener('click', async () => {
  try {
    const data = await api('/api/admin/sessions');
    $('#owner-sessions').replaceChildren(...data.sessions.map(session => text('li', `${session.current ? 'This session' : 'Another owner session'}: started ${new Date(session.createdAt).toLocaleString()}, expires ${new Date(session.expiresAt).toLocaleTimeString()}`)));
  } catch (error) { $('#status').textContent = error.message; }
});
async function loadReports() {
  $('#refresh-reports').disabled = true;
  try {
    const data = await api('/api/admin/reports');
    $('#report-status').textContent = data.reports.length ? `${data.reports.length} recent reports` : 'No reports submitted.';
    $('#reports').replaceChildren(...data.reports.map(report => {
      const article = text('article', ''); article.className = 'report';
      article.append(text('strong', `${report.category} · ${report.status}`), text('p', report.description || 'No additional description.'), text('small', new Date(report.createdAt).toLocaleString()));
      if (['OPEN', 'IN_REVIEW'].includes(report.status)) for (const [status, label] of [['IN_REVIEW', 'Review'], ['RESOLVED', 'Resolve'], ['DISMISSED', 'Dismiss']]) {
        const button = text('button', label); button.type = 'button';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try { await api(`/api/admin/reports/${encodeURIComponent(report.id)}/review`, { status }); await loadReports(); }
          catch (error) { $('#report-status').textContent = error.message; button.disabled = false; }
        }); article.append(button);
      }
      return article;
    }));
  } catch (error) { $('#report-status').textContent = error.message; }
  finally { $('#refresh-reports').disabled = false; }
}
$('#refresh-reports').addEventListener('click', loadReports);
const exportButton = text('button', 'Export daily CSV'); exportButton.type = 'button';
exportButton.addEventListener('click', () => {
  if (!lastSummary) return;
  const rows = [['Date (UTC)', 'Devices', 'Room ms', 'Listening ms', 'Sessions', 'Rooms created'],
    ...lastSummary.daily.map(row => [row.day, row.users, row.onlineMs, row.listeningMs, row.sessions, row.roomsCreated])];
  const url = URL.createObjectURL(new Blob([rows.map(row => row.join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'SangeetPitara-daily-usage.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('.toolbar').append(exportButton);
