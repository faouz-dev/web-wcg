const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createGameServer } = require('../server');
const { ROOM_TTL, RoomStore } = require('../lib/room-store');
const { io: connect } = require('socket.io-client');
const emit = (client, event, ...args) =>
  new Promise((resolve, reject) =>
    client
      .timeout(3000)
      .emit(event, ...args, (error, result) => (error ? reject(error) : resolve(result))),
  );
const alice = { name: 'Alice', token: 'alice-private-token-123456' };
const bob = { name: 'Bob', token: 'bob-private-token-12345678' };
async function launch(
  file,
  now,
  chooseLetter = (room, game) => ['a', 'i', 'e', 'e'][Math.min(3, game.history.length)],
) {
  const instance = await createGameServer({
    databaseUrl: '',
    allowLocalStore: true,
    dataFile: file,
    now,
    chooseLetter,
  });
  instance.server.listen(0);
  await once(instance.server, 'listening');
  const url = `http://localhost:${instance.server.address().port}`;
  const clients = [];
  return {
    ...instance,
    url,
    async client() {
      const client = connect(url, { transports: ['websocket'], forceNew: true });
      clients.push(client);
      await once(client, 'connect');
      client.on('room:state', (state) => {
        client.roomState = state;
      });
      return client;
    },
    async stop() {
      await instance.close();
      clients.forEach((client) => client.disconnect());
    },
  };
}
async function action(client, event, ...args) {
  if (event === 'game:word' && client.roomState?.turn !== client.id)
    await once(client, 'room:state');
  const update = once(client, 'room:state');
  if (event === 'game:word') args[0].turnId = client.roomState.turnId;
  assert.equal((await emit(client, event, ...args)).ok, true);
  return (await update)[0];
}
test('Room persistante : scores, historique, retour et redémarrage', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wordchain-'));
  const file = path.join(dir, 'rooms.json');
  let currentTime = Date.now();
  let app = await launch(file, () => currentTime);
  t.after(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const health = await fetch(app.url + '/healthz');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const page = await fetch(app.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Classement & historique/);
  let a = await app.client();
  let b = await app.client();
  assert.ok((await emit(a, 'room:create', { name: '   ', token: alice.token })).error);
  assert.ok((await emit(a, 'room:create', { name: 'Alice' })).error);
  const created = await action(a, 'room:create', { ...alice, lang: 'fr' });
  const code = created.code;
  const invitePage = await fetch(app.url + '/room/' + code);
  assert.equal(invitePage.status, 200);
  assert.match(await invitePage.text(), /id="join-form"/);
  assert.equal((await fetch(app.url + '/room/invalid-code')).status, 404);
  assert.ok((await emit(b, 'room:join', { ...bob, code: 'INVALID' })).error);
  await action(b, 'room:join', { ...bob, code });
  assert.ok((await emit(b, 'game:start')).error);
  await action(a, 'game:start');
  assert.ok((await emit(b, 'game:word', { word: 'ami' })).error);
  assert.ok((await emit(a, 'game:word', { word: 'chat' })).error);
  assert.ok((await emit(a, 'game:word', { word: 'azzzzzzz' })).error);
  const played = await action(a, 'game:word', { word: 'ami' });
  assert.equal(played.letter, 'i');
  assert.equal(played.turn, b.id);
  assert.equal(played.players[0].score, 3);
  await action(b, 'game:word', { word: 'image' });
  assert.ok((await emit(b, 'game:end')).error);
  const ended = await action(a, 'game:end');
  assert.equal(ended.started, false);
  assert.equal(ended.games.length, 1);
  assert.equal(ended.rankings[0].name, 'Bob');
  assert.equal(ended.rankings[0].points, 5);
  assert.equal(ended.rankings[0].wins, 1);
  assert.equal(ended.games[0].history.length, 2);
  assert.ok((await emit(a, 'game:end')).error);
  await emit(b, 'room:leave');
  await emit(a, 'room:leave');
  assert.ok(app.store.rooms.has(code));
  const returned = await action(a, 'room:join', { ...alice, name: 'Alice nouvelle', code });
  assert.equal(returned.rankings.length, 2);
  assert.equal(returned.rankings.find((p) => p.name === 'Alice nouvelle').points, 3);
  await action(a, 'game:start');
  await action(a, 'game:word', { word: 'ami' });
  await app.stop();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).rooms[0].game.history.length, 1);
  app = await launch(file, () => currentTime);
  a = await app.client();
  const resumed = await action(a, 'room:join', { ...alice, code });
  assert.equal(resumed.started, true);
  assert.equal(resumed.letter, 'i');
  assert.equal(resumed.turn, a.id);
  assert.equal(resumed.players[0].score, 3);
  await action(a, 'game:word', { word: 'image' });
  const soloEnded = await action(a, 'game:end');
  const aliceStats = soloEnded.rankings.find((p) => p.name === 'Alice');
  assert.equal(aliceStats.points, 11);
  assert.equal(aliceStats.games, 2);
  assert.equal(aliceStats.best, 8);
  assert.equal(aliceStats.wins, 0);
  await emit(a, 'room:leave');
  currentTime += ROOM_TTL - 1;
  await action(a, 'room:join', { ...alice, code }); // Retour avant expiration : le délai repart.
  await emit(a, 'room:leave');
  currentTime += ROOM_TTL;
  assert.match((await emit(a, 'room:join', { ...alice, code })).error, /expirée/);
  assert.equal(app.store.rooms.has(code), false);
});
test('Expiration : une room occupée reste vivante ; une base invalide est conservée', () => {
  const fs = require('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'wordchain-store-'));
  try {
    const file = path.join(dir, 'rooms.json');
    const store = new RoomStore(file, () => ROOM_TTL + 100);
    store.rooms.set('ABCDEF', { code: 'ABCDEF', lastPresenceAt: 0 });
    store.prune(new Set(['ABCDEF']));
    assert.equal(store.rooms.size, 1);
    store.prune();
    assert.equal(store.rooms.size, 0);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => new RoomStore(file), /conservé/);
    assert.equal(readFileSync(file, 'utf8'), '{broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('Capacité : 8 joueurs maximum et identité déjà connectée refusée', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wordchain-capacity-'));
  const app = await launch(path.join(dir, 'rooms.json'));
  t.after(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const host = await app.client();
  const room = await action(host, 'room:create', alice);
  const duplicate = await app.client();
  assert.match((await emit(duplicate, 'room:join', { ...alice, code: room.code })).error, /onglet/);
  for (let n = 0; n < 7; n++) {
    const client = await app.client();
    await action(client, 'room:join', {
      name: 'Joueur ' + n,
      token: 'unique-player-private-token-' + n,
      code: room.code,
    });
  }
  assert.match((await emit(duplicate, 'room:join', { ...bob, code: room.code })).error, /complète/);
});

test('Règles réelles : minimum, accents, doublons et rejeu d’un ancien tour', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wordchain-rules-'));
  const app = await launch(path.join(dir, 'rooms.json'));
  t.after(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = await app.client();
  await action(a, 'room:create', alice);
  const started = await action(a, 'game:start');
  assert.equal(started.minLength, 3);
  assert.equal(started.deadlineAt - started.serverTime <= 15000, true);
  assert.match(
    (await emit(a, 'game:word', { word: 'as', turnId: started.turnId, minLength: 1 })).error,
    /3 lettres/,
  );
  const first = await action(a, 'game:word', { word: 'ÂMÎ' });
  assert.equal(first.history[0].word, 'ami');
  assert.equal(first.minLength, 4);
  assert.match(
    (await emit(a, 'game:word', { word: 'image', turnId: started.turnId })).error,
    /tour est terminé/,
  );
  await action(a, 'game:word', { word: 'image' });
  const third = await action(a, 'game:word', { word: 'économie' });
  assert.equal(third.history.at(-1).word, 'economie');
  assert.equal(third.minLength, 6);
  assert.match(
    (await emit(a, 'game:word', { word: 'ECONOMIE', turnId: third.turnId })).error,
    /déjà été joué/,
  );
});
test('Expiration : élimination définitive, reconnexion sans retour en jeu, fin automatique au dernier échec', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wordchain-elimination-'));
  let time = 100000;
  const app = await launch(path.join(dir, 'rooms.json'), () => time);
  t.after(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = await app.client();
  const b = await app.client();
  const created = await action(a, 'room:create', alice);
  await action(b, 'room:join', { ...bob, code: created.code });
  let state = await action(a, 'game:start');
  let update = once(a, 'room:state');
  time = state.deadlineAt;
  state = (await update)[0];
  assert.equal(state.started, true);
  assert.equal(state.turn, b.id);
  assert.equal(state.nextTurn, b.id);
  assert.equal(state.currentScores.find((player) => player.name === 'Alice').eliminated, true);
  assert.equal(state.players.find((player) => player.id === a.id).spectator, true);
  assert.match(
    (await emit(a, 'game:word', { word: 'ami', turnId: state.turnId })).error,
    /éliminé/,
  );
  await emit(a, 'room:leave');
  const returned = await action(a, 'room:join', { ...alice, code: created.code });
  assert.equal(returned.players.find((player) => player.id === a.id).eliminated, true);
  time = state.deadlineAt;
  assert.ok(
    (
      await emit(b, 'game:word', {
        word: 'arbre',
        turnId: state.turnId,
        submittedAt: time - 10000,
        deadlineAt: time + 100000,
      })
    ).error,
  );
  const room = app.store.rooms.get(created.code);
  assert.equal(room.game, null);
  assert.equal(room.games.length, 1);
  assert.equal(room.games[0].reason, 'eliminated');
  assert.equal(room.games[0].results.length, 2);
  assert.equal(room.games[0].events.length, 2);
  assert.equal(room.games[0].history.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(room.games.length, 1);
  const newGame = await action(a, 'game:start');
  assert.equal(
    newGame.players.every((player) => !player.eliminated && !player.spectator),
    true,
  );
});

test('Arrivée en cours : spectateur toute la partie, participant à la suivante seulement', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wordchain-spectator-'));
  const app = await launch(path.join(dir, 'rooms.json'));
  t.after(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = await app.client();
  const b = await app.client();
  const room = await action(a, 'room:create', alice);
  await action(b, 'room:join', { ...bob, code: room.code });
  const start = await action(a, 'game:start');
  assert.equal(start.nextTurn, b.id);
  await action(a, 'game:word', { word: 'ami' });
  const c = await app.client();
  const observed = await action(c, 'room:join', {
    name: 'Camille',
    token: 'camille-private-token-123456',
    code: room.code,
  });
  assert.equal(observed.started, true);
  assert.equal(observed.turn, b.id);
  assert.equal(observed.nextTurn, a.id);
  assert.equal(observed.players.find((player) => player.id === c.id).spectator, true);
  assert.equal(observed.currentScores.length, 2);
  assert.equal(observed.currentScores[0].score, 3);
  assert.equal(observed.history[0].word, 'ami');
  assert.match(
    (await emit(c, 'game:word', { word: 'image', turnId: observed.turnId })).error,
    /Tu assistes/,
  );
  const nextRound = await action(b, 'game:word', { word: 'image' });
  assert.equal(nextRound.round, 2);
  assert.equal(nextRound.turn, a.id);
  assert.equal(nextRound.nextTurn, b.id);
  const game = app.store.rooms.get(room.code).game;
  assert.equal(Object.keys(game.participants).length, 2);
  assert.equal(game.roundRemaining.length, 2);
  await emit(b, 'room:leave');
  const solo = await action(a, 'game:word', { word: 'economie' });
  assert.equal(solo.turn, a.id);
  assert.equal(solo.nextTurn, a.id);
  assert.equal(solo.currentScores.length, 2);
  assert.equal(solo.currentScores.find((player) => player.name === 'Bob').connected, false);
  await emit(a, 'room:leave');
  const paused = await action(c, 'room:join', {
    name: 'Camille',
    token: 'camille-private-token-123456',
    code: room.code,
  });
  assert.equal(paused.paused, true);
  assert.equal(paused.deadlineAt, null);
  assert.equal(paused.turn, undefined);
  assert.match(
    (await emit(c, 'game:word', { word: 'elephant', turnId: paused.turnId })).error,
    /Tu assistes/,
  );
  const ended = await action(c, 'game:end');
  assert.equal(ended.games[0].results.length, 2);
  assert.equal(ended.rankings.find((player) => player.name === 'Camille').games, 0);
  const newGame = await action(c, 'game:start');
  assert.equal(newGame.players[0].spectator, false);
  assert.equal(newGame.turn, c.id);
  assert.equal(newGame.currentScores.length, 1);
  await action(c, 'game:word', { word: 'ami' });
});

test('Serveur réel : consigne aléatoire au lancement et nouvelle initiale après un mot valide', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wordchain-random-'));
  const app = await launch(path.join(dir, 'rooms.json'), undefined, null);
  t.after(async () => {
    await app.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = await app.client();
  await action(a, 'room:create', alice);
  const initial = await action(a, 'game:start');
  const words = readFileSync(
    path.join(__dirname, '..', 'wordList', 'fr', initial.letter.toUpperCase() + '.txt'),
    'utf8',
  )
    .split(/\r?\n/)
    .map((word) =>
      word
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim(),
    );
  const word = words.find((word) => /^[a-z]{3,40}$/.test(word) && word.startsWith(initial.letter));
  assert.ok(word);
  const next = await action(a, 'game:word', { word });
  assert.notEqual(next.letter, initial.letter);
  assert.equal(next.minLength, 4);
  assert.equal(next.history[0].letter, initial.letter);
});
