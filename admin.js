const $ = selector => document.querySelector(selector);
const number = value => Number(value || 0).toLocaleString();
const hours = value => `${(Number(value || 0) / 3_600_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }
function showLogin(message = '') {
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
    $('#login-panel').hidden = true; $('#dashboard').hidden = false; $('#logout').hidden = false;
    cards('#live-cards', [['Devices online', number(data.live.users)], ['Room connections', number(data.live.sessions)], ['Active rooms', number(data.live.rooms)], ['Live sources', number(data.live.streams)]]);
    cards('#lifetime-cards', [['Unique devices', number(data.lifetime.users)], ['Total room time', hours(data.lifetime.onlineMs)], ['Total listening time', hours(data.lifetime.listeningMs)], ['Rooms created', number(data.lifetime.roomsCreated)]]);
    cards('#period-cards', [['Devices', number(data.totals.users)], ['Room time', hours(data.totals.onlineMs)], ['Listening time', hours(data.totals.listeningMs)], ['Joins (incl. reconnects)', number(data.totals.sessions)], ['Reconnects', number(data.totals.reconnects)], ['Relay backlog drops', number(data.totals.dropped)]]);
    $('#daily').replaceChildren(...data.daily.map(row => { const tr = document.createElement('tr'); for (const value of [row.day, number(row.users), hours(row.onlineMs), hours(row.listeningMs), number(row.sessions), number(row.roomsCreated)]) tr.append(text('td', value)); return tr; }));
    if (!data.daily.length) { const row = document.createElement('tr'); const cell = text('td', 'No activity recorded in this period yet.'); cell.colSpan = 6; row.append(cell); $('#daily').append(row); }
    $('#platforms').replaceChildren(...data.platforms.map(row => { const div = text('div', `${row.platform}: ${number(row.users)} devices · ${hours(row.listeningMs)} listening`); div.className = 'platform'; return div; }));
    const insights = [];
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
