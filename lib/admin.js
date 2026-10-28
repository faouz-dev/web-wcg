const express = require('express');
const path = require('node:path');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const digest = (value) => createHash('sha256').update(String(value)).digest();
function mountAdmin(
  app,
  {
    analytics,
    store,
    presence,
    now = Date.now,
    password = process.env.ADMIN_PASSWORD,
    username = process.env.ADMIN_USERNAME || 'admin',
    secureCookies = process.env.NODE_ENV === 'production',
  },
) {
  const enabled = typeof password === 'string' && password.length >= 16;
  const expected = enabled ? digest(password) : null;
  const sessions = new Map();
  const attempts = new Map();
  const TTL = 8 * 3600000;
  const cookie = (token) =>
    `wcg_admin=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${token ? TTL / 1000 : 0}${secureCookies ? '; Secure' : ''}`;
  function originCheck(req, res, next) {
    const origin = req.get('origin');
    try {
      if (origin && new URL(origin).host !== req.get('host'))
        return res.status(403).json({ error: 'Origine refusée.' });
    } catch {
      return res.status(403).json({ error: 'Origine refusée.' });
    }
    if (req.get('sec-fetch-site') === 'cross-site')
      return res.status(403).json({ error: 'Origine refusée.' });
    next();
  }
  function session(req) {
    const token = /(?:^|;\s*)wcg_admin=([a-f0-9]{64})(?:;|$)/.exec(req.get('cookie') || '')?.[1];
    if (!token) return null;
    const key = digest(token).toString('hex');
    const expires = sessions.get(key);
    if (!expires || expires <= now()) {
      sessions.delete(key);
      return null;
    }
    return key;
  }
  function authorized(req, res, next) {
    if (!enabled)
      return res.status(503).json({
        error: 'Administration désactivée. Définis ADMIN_PASSWORD avec au moins 16 caractères.',
      });
    if (!session(req)) return res.status(401).json({ error: 'Connexion administrateur requise.' });
    next();
  }
  app.use('/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });
  app.get('/admin', (req, res) =>
    res.sendFile('index.html', { root: path.join(__dirname, '..', 'admin') }),
  );
  app.use('/admin/assets', express.static(path.join(__dirname, '..', 'admin'), { index: false }));
  app.post('/admin/api/login', originCheck, express.json({ limit: '2kb' }), (req, res) => {
    if (!enabled)
      return res
        .status(503)
        .json({ error: 'Définis ADMIN_PASSWORD (16 caractères minimum) sur le serveur.' });
    for (const [key, value] of attempts) if (value.until <= now()) attempts.delete(key);
    for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
    const key = req.ip;
    const current = attempts.get(key) || { count: 0, until: now() + 15 * 60000 };
    if (current.count >= 10 || attempts.size > 10000 || sessions.size > 1000) {
      res.set('Retry-After', '900');
      return res.status(429).json({ error: 'Trop de tentatives. Réessaie dans 15 minutes.' });
    }
    current.count++;
    attempts.set(key, current);
    if (
      typeof req.body?.password !== 'string' ||
      req.body.password.length > 1024 ||
      !timingSafeEqual(digest(req.body.password), expected) ||
      !timingSafeEqual(digest(req.body.username || ''), digest(username))
    )
      return res.status(401).json({ error: 'Identifiants incorrects.' });
    attempts.delete(key);
    const token = randomBytes(32).toString('hex');
    sessions.set(digest(token).toString('hex'), now() + TTL);
    res.set('Set-Cookie', cookie(token));
    res.json({ ok: true });
  });
  app.get('/admin/api/session', authorized, (req, res) => res.json({ username }));
  app.post('/admin/api/logout', originCheck, authorized, (req, res) => {
    sessions.delete(session(req));
    res.set('Set-Cookie', cookie(''));
    res.json({ ok: true });
  });
  app.get('/admin/api/stats', authorized, async (req, res) => {
    try {
      const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7;
      const stats = await analytics.report(days);
      stats.rooms = [...store.rooms.values()].map((room) => ({
        code: room.code,
        lang: room.lang,
        createdAt: room.createdAt,
        lastPresenceAt: room.lastPresenceAt,
        connected: presence.get(room.code)?.size || 0,
        playing: Boolean(room.game),
        members: Object.keys(room.members).length,
        games: room.games.length,
      }));
      stats.system = {
        storage: store.kind || 'json',
        persistenceHealthy: !store.lastError,
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        node: process.version,
        onlineConnections: analytics.online.size,
        proxyEnabled: analytics.trustProxy,
        geoApiEnabled: analytics.geolocation.enabled !== false,
        publicIpConnections: [...analytics.online.values()].filter(
          (info) => info.ipScope === 'public',
        ).length,
        nonPublicIpConnections: [...analytics.online.values()].filter(
          (info) => info.ipScope !== 'public',
        ).length,
        activeRooms: [...presence.values()].filter((value) => value.size).length,
        runningGames: stats.rooms.filter((room) => room.playing).length,
      };
      res.json(stats);
    } catch {
      res.status(503).json({ error: 'Statistiques indisponibles. Réessaie dans un instant.' });
    }
  });
  app.use('/admin/api', (error, req, res, next) =>
    res.status(400).json({ error: 'Requête invalide.' }),
  );
}
module.exports = { mountAdmin };
