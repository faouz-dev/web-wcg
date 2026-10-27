const $ = selector => document.querySelector(selector);
const fmt = value => new Intl.NumberFormat('fr-FR').format(value || 0);
const date = value => new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const countryNames = new Intl.DisplayNames(['fr'], { type: 'region' });
const country = (code, ipScope) => code === 'ZZ' ? ipScope === 'local' ? 'Connexion locale' : 'Pays inconnu' : countryNames.of(code) || code;
const duration = ms => ms >= 3600000 ? (ms / 3600000).toFixed(1) + ' h' : Math.round(ms / 60000) + ' min';
let loading = false;
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Requête impossible.'); error.status = response.status; throw error; }
  return data;
}
function loggedOut() { $('#dashboard').hidden = true; $('#login-view').hidden = false; $('#password').value = ''; }
async function loggedIn(username) { $('#login-view').hidden = true; $('#dashboard').hidden = false; $('#signed-in').textContent = username; await refresh(); }
$('#login-form').onsubmit = async event => {
  event.preventDefault(); const button = event.target.querySelector('button'); button.disabled = true; $('#login-error').textContent = '';
  try { await api('/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) }); $('#password').value = ''; await loggedIn($('#username').value); }
  catch (error) { $('#login-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('#logout').onclick = async () => { try { await api('/admin/api/logout', { method: 'POST' }); loggedOut(); } catch (error) { $('#dashboard-error').textContent = error.message; $('#dashboard-error').hidden = false; } };
$('#period').onchange = refresh; $('#refresh').onclick = refresh;
function table(target, headings, rows, empty) {
  const container = $(target); container.replaceChildren();
  if (!rows.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = empty; container.append(p); return; }
  const result = document.createElement('table'); const head = document.createElement('thead'); const tr = document.createElement('tr');
  headings.forEach(heading => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = heading; tr.append(th); }); head.append(tr); result.append(head);
  const body = document.createElement('tbody'); rows.forEach(row => { const line = document.createElement('tr'); row.forEach(value => { const cell = document.createElement('td'); cell.textContent = value; line.append(cell); }); body.append(line); }); result.append(body); container.append(result);
}
function svgNode(tag, attrs = {}, text) { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key,value] of Object.entries(attrs)) node.setAttribute(key,value); if (text !== undefined) node.textContent = text; return node; }
function chart(target, points, key, label) {
  const container = $(target); container.replaceChildren();
  const svg = svgNode('svg', { viewBox: '0 0 600 215', role: 'img', 'aria-label': label });
  const max = Math.max(1, ...points.map(item => item[key]));
  for (let i = 0; i < 4; i++) { const y = 22 + i * 50; svg.append(svgNode('line', {x1:38, y1:y, x2:580, y2:y, class:'grid'})); svg.append(svgNode('text', {x:28,y:y+3,'text-anchor':'end'}, Math.round(max * (1-i/3)))); }
  const xy = points.map((item,index) => [points.length === 1 ? 310 : 45 + index / (points.length - 1) * 530, 172 - item[key] / max * 150]);
  svg.append(svgNode('polyline', {points:xy.map(pair => pair.join(',')).join(' '),class:'series'}));
  xy.forEach(([x,y],index) => { const dot = svgNode('circle',{cx:x,cy:y,r:3,class:'dot'}); dot.append(svgNode('title',{},points[index].day + ' : ' + points[index][key])); svg.append(dot); });
  const indices = [...new Set([0, Math.floor((points.length-1)/2), points.length-1])];
  indices.forEach(index => { if (points[index]) svg.append(svgNode('text',{x:xy[index][0],y:200,'text-anchor':'middle'},points[index].day.slice(5).replace('-','/'))); });
  container.append(svg);
}
function countryBars(items) {
  $('#countries-chart').replaceChildren();
  const max = Math.max(1,...items.map(item => item.connections));
  if (!items.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Les premières connexions apparaîtront ici.'; $('#countries-chart').append(p); }
  items.slice(0,8).forEach(item => {
    const row = document.createElement('div'); row.className = 'country-row';
    const label = document.createElement('div'); label.className = 'country-label';
    const name = document.createElement('span'); name.textContent = country(item.country);
    const count = document.createElement('small'); count.textContent = fmt(item.connections) + ' connexions · ' + fmt(item.visitors) + ' navigateurs'; label.append(name,count);
    const meter = svgNode('svg',{viewBox:'0 0 100 7',preserveAspectRatio:'none',class:'country-meter',role:'img','aria-label':country(item.country) + ' : ' + item.connections}); meter.append(svgNode('rect',{width:100,height:7,rx:3}),svgNode('rect',{width:item.connections/max*100,height:7,rx:3,class:'country-value'}));
    row.append(label,meter); $('#countries-chart').append(row);
  });
}
async function refresh() {
  if (loading || $('#dashboard').hidden) return;
  loading = true; $('#refresh').disabled = true;
  try {
    const data = await api('/admin/api/stats?days=' + $('#period').value);
    $('#dashboard-error').hidden = true;
    $('#status').textContent = data.system.persistenceHealthy && !data.degraded ? '● Serveur opérationnel' : '● Stockage à vérifier';
    $('#status').classList.toggle('bad', !data.system.persistenceHealthy || data.degraded);
    $('#updated').textContent = 'Actualisé à ' + new Date(data.generatedAt).toLocaleTimeString('fr-FR');
    const metrics = { online: data.system.onlineConnections, visitors: data.totals.visitors, games: data.totals.gamesEnded, words: data.totals.wordsAccepted, rooms: data.system.activeRooms, errors: data.totals.errors };
    for (const [key,value] of Object.entries(metrics)) $('#metric-' + key).textContent = fmt(value);
    $('#games-started').textContent = fmt(data.totals.gamesStarted) + ' lancées sur la période';
    $('#words-rejected').textContent = fmt(data.totals.wordsRejected) + ' propositions refusées';
    $('#games-running').textContent = fmt(data.system.runningGames) + ' parties en cours ou en pause';
    chart('#connections-chart',data.daily,'connections','Connexions par jour'); chart('#games-chart',data.daily,'games','Parties terminées par jour'); chart('#errors-chart',data.daily,'errors','Erreurs serveur par jour');
    table('#daily-data',['Jour UTC','Connexions','Parties','Erreurs'],data.daily.map(item => [item.day,item.connections,item.games,item.errors]),'Aucune donnée.');
    countryBars(data.countries);
    $('#online-count').textContent = data.online.length + ' sessions';
    table('#online-table',['Joueur / visiteur','Pays estimé','Room','Connecté depuis'],data.online.map(item => [item.name || 'Visiteur #' + item.visitorId,country(item.country,item.ipScope),item.roomCode || 'Accueil',date(item.connectedAt)]),'Personne n’est connecté pour le moment.');
    $('#room-count').textContent = data.rooms.length + ' conservées';
    table('#rooms-table',['Room','Langue','Statut','Connectés','Parties terminées','Dernière présence'],data.rooms.map(item => [item.code,item.lang.toUpperCase(),item.playing ? 'Partie en cours / pause' : 'Salon',item.connected + '/8',item.games,date(item.lastPresenceAt)]),'Aucune room conservée.');
    table('#connections-table',['Date','Joueur / visiteur','Pays estimé'],data.recent.map(item => [date(item.at),item.name || 'Visiteur #' + item.visitorId,country(item.country,item.ipScope)]),'Aucune connexion enregistrée sur cette période.');
    $('#recent-errors').replaceChildren(); data.recentErrors.slice(0,5).forEach(item => { const p = document.createElement('p'); p.className = 'error-item'; p.textContent = date(item.at) + ' · ' + item.category; $('#recent-errors').append(p); });
    $('#system-storage').textContent = data.system.storage === 'postgres' ? 'PostgreSQL · persistant' : 'JSON local · développement';
    $('#system-uptime').textContent = duration(data.system.uptimeSeconds*1000); $('#system-memory').textContent = data.system.memoryMb + ' Mo'; $('#system-duration').textContent = duration(data.totals.averageSessionMs);
  } catch (error) {
    if (error.status === 401) return loggedOut();
    $('#dashboard-error').textContent = error.message; $('#dashboard-error').hidden = false; $('#status').textContent = '● Actualisation impossible'; $('#status').classList.add('bad');
  } finally { loading = false; $('#refresh').disabled = false; }
}
setInterval(() => { if ($('#auto-refresh').checked && !document.hidden) refresh(); },30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && $('#auto-refresh').checked) refresh(); });
api('/admin/api/session').then(data => loggedIn(data.username)).catch(error => { loggedOut(); if (error.status === 503) $('#login-error').textContent = error.message; });

const navigationLinks = [...document.querySelectorAll('.sidebar nav a')];
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    const current = entries.filter(entry => entry.isIntersecting).sort((a,b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!current) return;
    navigationLinks.forEach(link => {
      if (link.getAttribute('href') === '#' + current.target.id) link.setAttribute('aria-current','location');
      else link.removeAttribute('aria-current');
    });
  }, {rootMargin:'-5% 0px -65% 0px', threshold:0});
  navigationLinks.forEach(link => { const target = document.querySelector(link.getAttribute('href')); if (target) observer.observe(target); });
}
