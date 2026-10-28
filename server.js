const express = require('express');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { createLetterPicker } = require('./lib/letter-picker');
const { PostgresStore } = require('./lib/postgres-store');
const { Analytics, proxyEnabled } = require('./lib/analytics');
const { mountAdmin } = require('./lib/admin');
const { RoomStore, ROOM_TTL } = require('./lib/room-store');
const { TURN_MS, upgradeGame, beginTurn, advanceTurn, reconcilePresence, expireTurn } = require('./lib/turn-rules');
const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').trim();
async function createGameServer({ allowLocalStore = process.env.NODE_ENV !== 'production', databaseUrl = process.env.DATABASE_URL, pool, adminPassword = process.env.ADMIN_PASSWORD, adminUsername = process.env.ADMIN_USERNAME, trustProxy = proxyEnabled(), dataFile = process.env.ROOMS_FILE || path.join(__dirname, 'data', 'rooms.json'), now = Date.now, chooseLetter } = {}) {
  const app = express();
  const server = createServer(app);
  const io = new Server(server);
  if (!databaseUrl && !pool && !allowLocalStore) throw new Error('DATABASE_URL est requis en production. Configure la connexion PostgreSQL dans Render.');
  const store = databaseUrl || pool ? await PostgresStore.open({ connectionString: databaseUrl, pool, now }) : new RoomStore(dataFile, now);
  const analytics = new Analytics({ pool: store.pool, now, trustProxy });
  app.set('trust proxy', trustProxy ? 1 : false);
  const rooms = store.rooms;
  const presence = new Map();
  const dictionaries = new Map();
  const pickLetter = chooseLetter || createLetterPicker(dictionary);
  store.prune();
  for (const room of rooms.values()) {
    if (!room.game) continue;
    upgradeGame(room.game);
    room.game.promptTurnId = room.game.turnId;
    if (room.game.deadlineAt !== null) room.game.remainingMs = Math.max(0, Math.min(TURN_MS, room.game.deadlineAt - now()));
    room.game.deadlineAt = null;
  }
  try { await store.flush?.(); await analytics.prune(); } catch (error) { await store.close?.().catch(() => {}); throw error; }
  app.get('/healthz', (req, res) => res.status(store.lastError ? 503 : 200).json({ status: store.lastError ? 'degraded' : 'ok' }));
  mountAdmin(app, { analytics, store, presence, now, password: adminPassword, username: adminUsername });
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/room/:code', (req, res) => {
    if (!/^[a-z0-9]{6}$/i.test(req.params.code)) return res.status(404).send('Lien de room invalide.');
    res.sendFile('index.html', { root: path.join(__dirname, 'public') });
  });
  const online = room => presence.get(room.code) || new Map();
  const activeIds = room => [...online(room).keys()].filter(id => Boolean(room.game?.participants[id]) && room.game.participants[id].eliminatedAt == null);
  const hostId = room => online(room).get(room.ownerId) || online(room).values().next().value || null;
  function touch(room) { room.lastPresenceAt = now(); }
  function dictionary(lang, letter) {
    const key = `${lang}/${letter}`;
    if (!dictionaries.has(key)) dictionaries.set(key, new Set(readFileSync(path.join(__dirname, 'wordList', lang, `${letter.toUpperCase()}.txt`), 'utf8').split(/\r?\n/).filter(Boolean).map(normalize)));
    return dictionaries.get(key);
  }
  function rankings(room) {
    return Object.values(room.members).map(member => {
      const results = room.games.flatMap(game => game.results.filter(result => result.memberId === member.id));
      return { memberId: member.id, name: member.name, points: results.reduce((sum, result) => sum + result.score, 0), games: results.length, wins: results.filter(result => result.winner).length, best: Math.max(0, ...results.map(result => result.score)) };
    }).sort((a, b) => b.points - a.points || b.wins - a.wins);
  }
  function snapshot(room) {
    const game = room.game;
    const ids = activeIds(room);
    const nextMemberId = game ? game.roundRemaining.find(id => id !== game.turnMemberId && ids.includes(id)) || ids[0] : null;
    return {
      code: room.code, lang: room.lang, host: hostId(room),
      players: [...online(room)].map(([memberId, id]) => ({ id, memberId, name: room.members[memberId].name, score: game?.participants[memberId]?.score || 0, eliminated: game?.participants[memberId]?.eliminatedAt != null, spectator: Boolean(game && (!game.participants[memberId] || game.participants[memberId].eliminatedAt != null)) })),
      nextTurn: game ? online(room).get(nextMemberId) || null : null,
      currentScores: game ? Object.entries(game.participants).map(([memberId, player]) => ({ memberId, name: room.members[memberId]?.name || player.name, score: player.score, eliminated: player.eliminatedAt != null, connected: online(room).has(memberId), current: player.eliminatedAt == null && game.turnMemberId === memberId, next: player.eliminatedAt == null && nextMemberId === memberId })).sort((a, b) => b.score - a.score) : [],
      started: Boolean(game), paused: Boolean(game && game.deadlineAt === null), turn: game ? online(room).get(game.turnMemberId) : null,
      letter: game?.letter || 'a', history: game?.history || [],
      round: game?.round || 1, minLength: game?.minLength || 3, deadlineAt: game?.deadlineAt ?? null, turnId: game?.turnId || null, serverTime: now(), turnDuration: TURN_MS, lastEvent: game?.lastEvent || null,
      createdAt: room.createdAt, expiresAt: room.lastPresenceAt + ROOM_TTL,
      rankings: rankings(room), games: room.games.slice().reverse(),
    };
  }
  function broadcast(room) { io.to(room.code).emit('room:state', snapshot(room)); }
  function refreshPrompt(room) {
    const game = room.game;
    if (!game || !game.turnMemberId || game.deadlineAt === null || game.promptTurnId === game.turnId) return;
    game.letter = pickLetter(room, game);
    game.promptTurnId = game.turnId;
    game.deadlineAt = now() + game.remainingMs;
  }
  function finishGame(room, reason) {
    const game = room.game;
    const best = Math.max(...Object.values(game.participants).map(player => player.score));
    const multiplayer = Object.keys(game.participants).length > 1;
    room.games.push({ id: game.id, reason, startedAt: game.startedAt, endedAt: now(), history: game.history, events: game.events, rounds: game.round, results: Object.entries(game.participants).map(([memberId, player]) => ({ memberId, name: player.name, score: player.score, eliminatedAt: player.eliminatedAt ?? null, winner: multiplayer && best > 0 && player.score === best })) });
    analytics.record('game_ended', { roomCode: room.code, payload: { reason, durationMs: now() - game.startedAt, players: Object.keys(game.participants).length } });
    room.game = null;
  }
  function alignTurn(room) {
    if (room.game) { reconcilePresence(room.game, activeIds(room), now()); refreshPrompt(room); }
  }
  function settleRoom(room) {
    if (!room.game || !expireTurn(room.game, activeIds(room), now())) return false;
    if (Object.values(room.game.participants).every(player => player.eliminatedAt != null)) finishGame(room, 'eliminated');
    else refreshPrompt(room);
    touch(room); store.save(); broadcast(room); return true;
  }
  function leave(socket) {
    const room = rooms.get(socket.data.code);
    if (!room) return;
    settleRoom(room);
    const members = online(room);
    if (members.get(socket.data.memberId) === socket.id) members.delete(socket.data.memberId);
    if (!members.size) presence.delete(room.code);
    socket.leave(room.code); socket.data.code = null;
    if (analytics.online.has(socket.id)) analytics.online.get(socket.id).roomCode = null;
    touch(room); alignTurn(room); store.save(); broadcast(room);
  }
  function identify(data) {
    const name = String(data?.name || '').trim().slice(0, 20);
    if (!name) throw Object.assign(new Error('Choisis un pseudo pour jouer.'), { code: 'VALIDATION_ERROR' });
    if (typeof data?.token !== 'string' || !/^[a-zA-Z0-9_-]{20,128}$/.test(data.token)) throw Object.assign(new Error('Identité locale manquante. Recharge la page.'), { code: 'VALIDATION_ERROR' });
    return { name, memberId: createHash('sha256').update(data.token).digest('hex') };
  }
  function enter(socket, room, identity) {
    leave(socket);
    if (!presence.has(room.code)) presence.set(room.code, new Map());
    online(room).set(identity.memberId, socket.id);
    room.members[identity.memberId] = { id: identity.memberId, name: identity.name };
    socket.data.memberId = identity.memberId; socket.data.code = room.code;
    analytics.identify(socket, identity, room.code); socket.join(room.code);
    // Le groupe de participants est fixé au lancement ; les nouveaux observent jusqu’à la partie suivante.
    touch(room); alignTurn(room); store.save(); broadcast(room);
  }
  io.on('connection', socket => {
    analytics.connect(socket);
    function handle(event, callback) {
      socket.on(event, async (...args) => {
        const ack = typeof args.at(-1) === 'function' ? args.pop() : () => {};
        let result;
        try {
          callback(args[0] || {}, value => { result = value; });
          if (event !== 'clock:sync') await store.flush?.();
          if (event === 'game:word' && result?.error) analytics.forSocket(socket, 'word_rejected');
          ack(result);
        } catch (error) {
          if (error.code !== 'VALIDATION_ERROR') { console.error('Échec opération :', event, error.code || error.name); analytics.forSocket(socket, 'error', { category: event }); }
          ack({ error: error.code === 'VALIDATION_ERROR' ? error.message : 'Opération indisponible. Réessaie dans un instant.' });
        }
      });
    }
    handle('clock:sync', (data, ack) => ack({ serverTime: now() }));
    handle('room:create', (data, ack) => {
      const identity = identify(data);
      let code;
      do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
      const room = { code, lang: data.lang === 'en' ? 'en' : 'fr', ownerId: identity.memberId, createdAt: now(), lastPresenceAt: now(), members: {}, game: null, games: [] };
      rooms.set(code, room); enter(socket, room, identity); analytics.forSocket(socket, 'room_created'); ack({ ok: true });
    });
    handle('room:join', (data, ack) => {
      const identity = identify(data);
      store.prune(new Set(presence.keys()));
      const room = rooms.get(String(data.code || '').trim().toUpperCase());
      if (!room) return ack({ error: 'Room introuvable ou expirée après 7 jours sans présence.' });
      const existing = online(room).get(identity.memberId);
      if (existing && existing !== socket.id) return ack({ error: 'Tu es déjà dans cette room dans un autre onglet.' });
      if (existing === socket.id) { socket.emit('room:state', snapshot(room)); return ack({ ok: true }); }
      if (online(room).size >= 8) return ack({ error: 'Cette room est complète (8 joueurs).' });
      enter(socket, room, identity); ack({ ok: true });
    });
    handle('game:start', (data, ack) => {
      const room = rooms.get(socket.data.code);
      if (!room || hostId(room) !== socket.id) return ack({ error: 'Seul l’hôte peut lancer la partie.' });
      if (room.game) return ack({ error: 'La partie est déjà lancée.' });
      room.game = { id: randomBytes(8).toString('hex'), startedAt: now(), participants: Object.fromEntries([...online(room).keys()].map(id => [id, { name: room.members[id].name, score: 0 }])), turnMemberId: online(room).keys().next().value, letter: 'a', history: [] };
      upgradeGame(room.game);
      room.game.roundRemaining = [...online(room).keys()];
      beginTurn(room.game, now());
      refreshPrompt(room);
      analytics.forSocket(socket, 'game_started');
      touch(room); store.save(); ack({ ok: true }); broadcast(room);
    });
    handle('game:end', (data, ack) => {
      const room = rooms.get(socket.data.code);
      if (!room || hostId(room) !== socket.id) return ack({ error: 'Seul l’hôte peut terminer la partie.' });
      if (!room.game) return ack({ error: 'Aucune partie en cours.' });
      finishGame(room, 'manual');
      touch(room); store.save(); ack({ ok: true }); broadcast(room);
    });
    handle('game:word', (data, ack) => {
      const room = rooms.get(socket.data.code);
      if (room?.game?.participants[socket.data.memberId]?.eliminatedAt != null) return ack({ error: 'Tu es éliminé. Tu rejoueras à la prochaine partie.' });
      if (room?.game && !room.game.participants[socket.data.memberId]) return ack({ error: 'Tu assistes à cette partie. Tu joueras à la prochaine.' });
      if (room && settleRoom(room)) return ack({ error: 'Temps écoulé ! Le tour est passé.' });
      const game = room?.game;
      if (!game || game.turnMemberId !== socket.data.memberId) return ack({ error: 'Attends ton tour.' });
      if (data.turnId !== game.turnId) return ack({ error: 'Ce tour est terminé. Attends la nouvelle consigne.' });
      const word = normalize(String(data.word || '')); 
      if (!/^[a-z]{2,40}$/.test(word)) return ack({ error: 'Entre un mot de 2 à 40 lettres.' });
      if (word.length < game.minLength) return ack({ error: `Il faut au moins ${game.minLength} lettres.` });
      if (!word.startsWith(game.letter)) return ack({ error: `Le mot doit commencer par ${game.letter.toUpperCase()}.` });
      if (game.history.some(item => item.word === word)) return ack({ error: 'Ce mot a déjà été joué !' });
      if (!dictionary(room.lang, game.letter).has(word)) return ack({ error: 'Ce mot n’est pas dans le dictionnaire.' });
      const memberId = socket.data.memberId;
      game.participants[memberId].score += word.length;
      analytics.forSocket(socket, 'word_accepted');
      game.history.push({ word, memberId, name: room.members[memberId].name, letter: game.letter, minLength: game.minLength });
      advanceTurn(game, activeIds(room), now(), 'word');
      refreshPrompt(room);
      touch(room); store.save(); ack({ ok: true }); broadcast(room);
    });
    handle('room:leave', (data, ack) => { leave(socket); ack({ ok: true }); });
    socket.on('disconnect', () => { try { leave(socket); } catch { analytics.forSocket(socket, 'error', { category: 'disconnect' }); } analytics.disconnect(socket); });
  });
  const turnTicker = setInterval(() => {
    try { for (const code of presence.keys()) settleRoom(rooms.get(code)); }
    catch (error) { console.error('Erreur minuteur'); analytics.record('error', {payload:{category:'timer'}}); }
  }, 100);
  turnTicker.unref();
  const maintenance = setInterval(() => {
    try {
      for (const code of presence.keys()) touch(rooms.get(code));
      store.prune(new Set(presence.keys()));
      if (presence.size) store.save();
    } catch (error) { console.error('Erreur entretien des rooms'); analytics.record('error', {payload:{category:'maintenance'}}); }
  }, 60000);
  maintenance.unref();
  const retention = setInterval(() => analytics.prune().catch(() => { analytics.lastError = 'Purge indisponible.'; }), 3600000);
  retention.unref();
  async function close() { clearInterval(retention); clearInterval(turnTicker); clearInterval(maintenance); await new Promise(resolve => io.close(resolve)); await analytics.close(); await store.close?.(); }
  return { server, io, store, analytics, close };
}
if (require.main === module) {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  createGameServer().then(instance => {
    instance.server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Word Chain démarré sur le port ' + (process.env.PORT || 3000)));
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { try { await instance.close(); process.exit(0); } catch { process.exit(1); } });
  }).catch(() => { console.error('Démarrage impossible : vérifie DATABASE_URL, PostgreSQL et la configuration du serveur.'); process.exitCode = 1; });
}
module.exports = { createGameServer };
