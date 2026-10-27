const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { newDb } = require('pg-mem');
const { PostgresStore } = require('../lib/postgres-store');
const { ROOM_TTL } = require('../lib/room-store');
const { Analytics, clientIp, countryFor } = require('../lib/analytics');
const { createGameServer } = require('../server');
const { io: connect } = require('socket.io-client');
function database() { const db = newDb({ noAstCoverageCheck: true }); /* pg-mem ne couvre pas le second CREATE TABLE IF NOT EXISTS. */ const { Pool } = db.adapters.createPg(); return { db, pool: new Pool() }; }
const room = (code, at = 10000) => ({ code, lang: 'fr', ownerId: 'owner', createdAt: at, lastPresenceAt: at, members: {}, game: null, games: [] });
test('PostgreSQL : sauvegarde, rechargement, ordre des écritures et expiration', async () => {
  const { db, pool } = database();
  const store = await PostgresStore.open({ pool, now: () => 10000 });
  store.rooms.set('ABC123', room('ABC123'));
  store.save(); store.rooms.get('ABC123').games.push({ id: 'first' }); await store.save();
  assert.equal(db.public.many('select * from wcg_rooms')[0].data.games.length, 1);
  const { Pool } = db.adapters.createPg();
  const restored = await PostgresStore.open({ pool: new Pool(), now: () => 10000 + ROOM_TTL });
  assert.equal(restored.rooms.get('ABC123').games[0].id, 'first');
  restored.prune(new Set(['ABC123'])); assert.equal(restored.rooms.size, 1);
  restored.prune(); await restored.flush(); assert.equal(db.public.many('select * from wcg_rooms').length, 0);
  await restored.close(); await store.close();
});
test('PostgreSQL : une écriture échouée est signalée et peut être retentée sans effacer les rooms', async () => {
  const { pool } = database(); const store = await PostgresStore.open({ pool });
  const connect = pool.connect.bind(pool); let fail = true;
  pool.connect = async () => { if (fail) throw new Error('network secret-connection-string'); return connect(); };
  store.rooms.set('ABC123', room('ABC123'));
  await assert.rejects(store.save(), error => error.code === 'DB_SAVE_FAILED' && !error.message.includes('secret'));
  assert.equal(store.rooms.size, 1); assert.ok(store.lastError);
  fail = false; await store.save(); assert.equal(store.lastError, null); await store.close();
});
test('Géolocalisation : proxy uniquement si configuré, pays inconnu explicite et IP non persistée', () => {
  const request = { headers: { 'x-forwarded-for': '1.1.1.1, 8.8.8.8' }, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  assert.equal(clientIp(request, false), '127.0.0.1'); assert.equal(clientIp(request, true), '8.8.8.8');
  assert.equal(countryFor({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), 'ZZ');
  const analytics = new Analytics({ now: () => 1000 });
  analytics.connect({ id: 'socket1', handshake: { auth: {token:'private-identity-token-123456'} }, request });
  assert.equal(JSON.stringify(analytics.events).includes('127.0.0.1'), false);
  assert.equal(JSON.stringify(analytics.events).includes('private-identity-token'), false);
});
test('Statistiques PostgreSQL : navigateurs uniques, pays, noms, graphiques et purge 30 jours', async () => {
  const { pool } = database(); const time = Date.UTC(2026,9,27,12);
  const store = await PostgresStore.open({pool}); const analytics = new Analytics({pool,now: () => time});
  analytics.record('connection',{visitorId:'browser1',country:'FR'});
  analytics.record('connection',{visitorId:'browser1',country:'FR'});
  analytics.record('connection',{visitorId:'browser2',country:'TG'});
  analytics.record('room_joined',{visitorId:'browser1',name:'Camille',country:'FR'});
  analytics.record('game_started'); analytics.record('game_ended'); analytics.record('word_accepted'); analytics.record('word_rejected'); analytics.record('error',{payload:{category:'database'}});
  let report = await analytics.report(7);
  assert.equal(report.totals.connections,3); assert.equal(report.totals.visitors,2); assert.equal(report.totals.gamesEnded,1);
  assert.equal(report.countries[0].country,'FR'); assert.equal(report.daily.at(-1).connections,3);
  assert.ok(report.recent.some(item => item.name === 'Camille')); assert.equal(report.totals.errors,1);
  const old = new Analytics({pool,now: () => time - 31*86400000}); old.record('connection',{visitorId:'old'}); await old.pending;
  await analytics.prune();
  assert.equal((await pool.query('SELECT * FROM wcg_events WHERE visitor_id = $1',['old'])).rows.length,0);
  await store.close();
});
async function openAdmin(t, options = {}) {
  const { pool } = database();
  const instance = await createGameServer({ databaseUrl:'', pool, adminPassword:'test-admin-password-strong-123', adminUsername:'admin', chooseLetter: () => 'a', ...options });
  instance.server.listen(0); await once(instance.server,'listening');
  t.after(() => instance.close());
  return { ...instance, url:'http://localhost:' + instance.server.address().port };
}
async function login(url, body, origin) {
  return fetch(url + '/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json',...(origin ? { Origin:origin } : {})},body:JSON.stringify(body)});
}
test('Admin : routes protégées, cookie sécurisé, refus CSRF, statistiques authentifiées et logout', async t => {
  const app = await openAdmin(t);
  assert.equal((await fetch(app.url + '/admin')).status,200);
  assert.equal((await fetch(app.url + '/admin/api/stats')).status,401);
  assert.equal((await login(app.url,{username:'admin',password:'wrong'})).status,401);
  assert.equal((await login(app.url,{username:'admin',password:'test-admin-password-strong-123'},'https://evil.example')).status,403);
  const response = await login(app.url,{username:'admin',password:'test-admin-password-strong-123'});
  assert.equal(response.status,200);
  const cookie = response.headers.get('set-cookie'); assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
  const headers = {Cookie:cookie.split(';')[0]};
  let stats = await fetch(app.url + '/admin/api/stats?days=7',{headers}); assert.equal(stats.status,200);
  const data = await stats.json(); assert.equal(data.system.storage,'postgres'); assert.equal(data.daily.length,7);
  assert.equal(JSON.stringify(data).includes('test-admin-password'),false);
  assert.equal((await fetch(app.url + '/admin/api/logout',{method:'POST',headers})).status,200);
  assert.equal((await fetch(app.url + '/admin/api/stats',{headers})).status,401);
});
test('Admin : désactivé sans mot de passe et tentatives limitées', async t => {
  const disabled = await openAdmin(t,{adminPassword:''});
  assert.equal((await fetch(disabled.url + '/admin/api/stats')).status,503);
  const app = await openAdmin(t);
  for (let i = 0; i < 10; i++) assert.equal((await login(app.url,{username:'admin',password:'wrong'})).status,401);
  assert.equal((await login(app.url,{username:'admin',password:'wrong'})).status,429);
});
test('Intégration : une room créée par Socket.IO est durable dans PostgreSQL et remonte dans l’admin', async t => {
  const app = await openAdmin(t);
  const socket = connect(app.url,{transports:['websocket'],auth:{token:'test-private-browser-token-123456'}});
  t.after(() => socket.disconnect()); await once(socket,'connect');
  const update = once(socket,'room:state');
  const ack = await new Promise(resolve => socket.emit('room:create',{name:'Camille',token:'test-private-browser-token-123456',lang:'fr'},resolve));
  assert.equal(ack.ok,true); const state = (await update)[0];
  const rows = await app.store.pool.query('SELECT data FROM wcg_rooms WHERE code = $1',[state.code]); assert.equal(rows.rows.length,1);
  const response = await login(app.url,{username:'admin',password:'test-admin-password-strong-123'});
  const headers = {Cookie:response.headers.get('set-cookie').split(';')[0]};
  const stats = await (await fetch(app.url+'/admin/api/stats',{headers})).json();
  assert.equal(stats.system.onlineConnections,1); assert.equal(stats.online[0].name,'Camille'); assert.equal(stats.rooms[0].code,state.code);
  assert.equal(stats.totals.connections,1);
  const startState = once(socket,'room:state');
  assert.equal((await new Promise(resolve => socket.emit('game:start',resolve))).ok,true);
  const started = (await startState)[0];
  const played = once(socket,'room:state');
  assert.equal((await new Promise(resolve => socket.emit('game:word',{word:'ami',turnId:started.turnId},resolve))).ok,true);
  await played;
  assert.equal((await new Promise(resolve => socket.emit('game:end',resolve))).ok,true);
  await app.analytics.pending;
  const durable = (await app.store.pool.query('SELECT data FROM wcg_rooms WHERE code = $1',[state.code])).rows[0].data;
  assert.equal(durable.games[0].results[0].score,3);
  const finalStats = await app.analytics.report(7);
  assert.equal(finalStats.totals.gamesStarted,1); assert.equal(finalStats.totals.gamesEnded,1); assert.equal(finalStats.totals.wordsAccepted,1);
});

test('Configuration : aucune sauvegarde locale silencieuse en production', async () => {
  await assert.rejects(createGameServer({databaseUrl:'', allowLocalStore:false}), /DATABASE_URL est requis/);
});

test('Pays API : enrichissement PostgreSQL après déconnexion, sans ressusciter le visiteur ni stocker son IP', async () => {
  const { pool } = database(); const store = await PostgresStore.open({pool});
  let complete;
  const analytics = new Analytics({pool,geolocation:{resolve:() => new Promise(resolve => {complete = resolve;})}});
  const socket = {id:'enrichment-test',handshake:{auth:{token:'browser-private-token-123456'}},request:{headers:{},socket:{remoteAddress:'8.8.8.8'}}};
  analytics.connect(socket);
  assert.equal(analytics.online.size,1);
  analytics.identify(socket,{memberId:'member-test',name:'Camille'},'ABC123');
  analytics.disconnect(socket); assert.equal(analytics.online.size,0);
  complete('TG'); await analytics.close();
  const report = await analytics.report(7);
  assert.equal(report.online.length,0); assert.equal(report.recent[0].country,'TG');
  assert.equal(report.countries[0].country,'TG'); assert.equal(report.totals.connections,1);
  const records = (await pool.query('SELECT * FROM wcg_events')).rows;
  assert.equal(JSON.stringify(records).includes('8.8.8.8'),false);
  await store.close();
});
