const { randomUUID, createHash } = require('node:crypto');
const { isIP } = require('node:net');
const geoip = require('geoip-lite');
const { CountryResolver, publicIp } = require('./country-resolver');
const RETENTION_MS = 30 * 86400000;
function clientIp(request, trustProxy = false) {
  const forwarded = request.headers?.['x-forwarded-for'];
  const raw = trustProxy && typeof forwarded === 'string' ? forwarded.split(',').at(-1).trim() : request.socket?.remoteAddress || '';
  const ip = raw.replace(/^::ffff:/, ''); return isIP(ip) ? ip : null;
}
function countryFor(request, trustProxy = false) {
  const ip = clientIp(request, trustProxy); if (!ip) return 'ZZ';
  try { return geoip.lookup(ip)?.country || 'ZZ'; } catch { return 'ZZ'; }
}
function visitorId(token, fallback) { return typeof token === 'string' && /^[a-zA-Z0-9_-]{20,128}$/.test(token) ? createHash('sha256').update(token).digest('hex') : 'anonymous:' + fallback; }
class Analytics {
  constructor({ pool, now = Date.now, trustProxy = false, geolocation } = {}) { this.pool = pool; this.now = now; this.trustProxy = trustProxy; this.events = []; this.online = new Map(); this.pending = Promise.resolve(); this.lastError = null; this.startedAt = now(); this.geolocation = geolocation || new CountryResolver({now}); this.geoTasks = new Set(); }
  record(type, fields = {}) {
    const event = { id: randomUUID(), type, at: this.now(), visitorId: fields.visitorId || null, name: fields.name || null, country: fields.country || 'ZZ', roomCode: fields.roomCode || null, payload: fields.payload || {} };
    if (!this.pool) { this.events.push(event); this.events = this.events.filter(item => item.at >= this.now() - RETENTION_MS).slice(-50000); return event; }
    this.pending = this.pending.catch(() => {}).then(() => this.pool.query('INSERT INTO wcg_events (id, type, at, visitor_id, name, country, room_code, payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [event.id, event.type, event.at, event.visitorId, event.name, event.country, event.roomCode, JSON.stringify(event.payload)])).then(() => { this.lastError = null; }, () => { this.lastError = 'Statistiques indisponibles.'; });
    return event;
  }
  connect(socket) {
    const ip = clientIp(socket.request, this.trustProxy);
    const ipScope = ip ? publicIp(ip) ? 'public' : 'local' : 'unknown';
    const info = { visitorId: visitorId(socket.handshake.auth?.token, socket.id), name: null, country: countryFor(socket.request, this.trustProxy), ipScope, connectedAt: this.now(), roomCode: null };
    this.online.set(socket.id, info);
    const event = this.record('connection', { ...info, payload: { ipScope } });
    const task = this.geolocation.resolve(ip, info.country).then(country => {
      if (country === info.country) return;
      info.country = country;
      if (!this.pool) { event.country = country; return; }
      this.pending = this.pending.catch(() => {}).then(() => this.pool.query('UPDATE wcg_events SET country = $1 WHERE id = $2', [country, event.id])).then(() => {}, () => { this.lastError = 'Mise à jour du pays indisponible.'; });
      return this.pending;
    }).catch(() => {}).finally(() => this.geoTasks.delete(task));
    this.geoTasks.add(task);
  }
  identify(socket, identity, roomCode) {
    const info = this.online.get(socket.id); if (!info) return;
    info.visitorId = identity.memberId; info.name = identity.name; info.roomCode = roomCode;
    this.record('room_joined', info);
  }
  disconnect(socket) {
    const info = this.online.get(socket.id); if (!info) return;
    this.record('disconnection', { ...info, payload: { durationMs: Math.max(0, this.now() - info.connectedAt) } }); this.online.delete(socket.id);
  }
  forSocket(socket, type, payload = {}) { this.record(type, { ...this.online.get(socket.id), payload }); }
  async close() { await Promise.allSettled([...this.geoTasks]); await this.pending; }
  async prune() { if (this.pool) await this.pool.query('DELETE FROM wcg_events WHERE at < $1', [this.now() - RETENTION_MS]); }
  async report(days = 7) {
    await this.pending;
    const dayStart = new Date(this.now()); dayStart.setUTCHours(0,0,0,0);
    const since = dayStart.getTime() - (days - 1) * 86400000;
    let events;
    if (this.pool) {
      const result = await this.pool.query('SELECT id, type, at, visitor_id, name, country, room_code, payload FROM wcg_events WHERE at >= $1 ORDER BY at ASC', [since]);
      events = result.rows.map(row => ({ id: row.id, type: row.type, at: Number(row.at), visitorId: row.visitor_id, name: row.name, country: row.country, roomCode: row.room_code, payload: row.payload }));
    } else events = this.events.filter(event => event.at >= since);
    const connections = events.filter(event => event.type === 'connection');
    const unique = values => new Set(values.filter(Boolean)).size;
    const daily = new Map();
    for (let i = days - 1; i >= 0; i--) { const day = new Date(this.now() - i * 86400000).toISOString().slice(0,10); daily.set(day, { day, connections: 0, games: 0, errors: 0 }); }
    const countries = new Map(); const names = new Map();
    for (const event of events) {
      if (event.name && event.visitorId) names.set(event.visitorId, event.name);
      const day = daily.get(new Date(event.at).toISOString().slice(0,10));
      if (day && event.type === 'connection') day.connections++;
      if (day && event.type === 'game_ended') day.games++;
      if (day && event.type === 'error') day.errors++;
      if (event.type === 'connection') { const item = countries.get(event.country) || { country: event.country, connections: 0, visitors: new Set() }; item.connections++; item.visitors.add(event.visitorId); countries.set(event.country, item); }
    }
    const count = type => events.filter(event => event.type === type).length;
    const durations = events.filter(event => event.type === 'disconnection').map(event => Number(event.payload.durationMs || 0));
    return {
      days, since, generatedAt: this.now(), startedAt: this.startedAt,
      totals: { connections: connections.length, visitors: unique(connections.map(event => event.visitorId)), gamesStarted: count('game_started'), gamesEnded: count('game_ended'), wordsAccepted: count('word_accepted'), wordsRejected: count('word_rejected'), errors: count('error'), averageSessionMs: durations.length ? Math.round(durations.reduce((a,b) => a+b,0) / durations.length) : 0 },
      daily: [...daily.values()], countries: [...countries.values()].map(item => ({ country: item.country, connections: item.connections, visitors: item.visitors.size })).sort((a,b) => b.connections-a.connections),
      online: [...this.online.values()].map(info => ({ ...info, visitorId: info.visitorId.slice(0,12) })),
      recent: connections.slice(-100).reverse().map(event => ({ at: event.at, name: names.get(event.visitorId) || null, visitorId: event.visitorId?.slice(0,12), country: event.country, ipScope: event.payload.ipScope || null })),
      recentErrors: events.filter(event => event.type === 'error').slice(-30).reverse().map(event => ({ at: event.at, category: event.payload.category || 'server' })),
      storage: this.pool ? 'postgres' : 'memory', degraded: Boolean(this.lastError),
    };
  }
}
module.exports = { Analytics, clientIp, countryFor, visitorId };
