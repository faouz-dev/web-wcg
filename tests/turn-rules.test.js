const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TURN_MS, upgradeGame, beginTurn, advanceTurn, reconcilePresence, expireTurn } = require('../lib/turn-rules');
const { GameClock } = require('../public/clock');
function game(ids = ['a','b']) {
  const game = { participants: Object.fromEntries(ids.map(id => [id, { name: id, score: 0 }])), turnMemberId: ids[0] };
  upgradeGame(game); beginTurn(game, 1000); return game;
}
test('15 secondes exactes, passage automatique, aucun point offert', () => {
  const g = game(); const oldTurn = g.turnId;
  assert.equal(g.deadlineAt, 16000); assert.equal(expireTurn(g, ['a','b'], 15999), false);
  assert.equal(expireTurn(g, ['a','b'], 16000), true);
  assert.equal(g.turnMemberId, 'b'); assert.equal(g.round, 1); assert.equal(g.minLength, 3);
  assert.notEqual(g.turnId, oldTurn); assert.equal(g.deadlineAt, 31000);
  assert.equal(g.participants.a.score, 0); assert.equal(g.events.length, 1);
  assert.equal(expireTurn(g, ['a','b'], 16000), false);
});
test('La longueur augmente après un tour complet, plafonne à 10 et les nouveaux attendent le tour suivant', () => {
  const g = game();
  reconcilePresence(g, ['a','b','c'], 2000);
  advanceTurn(g, ['a','b','c'], 3000, 'word'); assert.equal(g.turnMemberId, 'b'); assert.equal(g.minLength, 3);
  advanceTurn(g, ['a','b','c'], 4000, 'word'); assert.equal(g.round, 2); assert.equal(g.minLength, 4); assert.deepEqual(g.roundRemaining, ['a','b','c']);
  for (let i = 0; i < 40; i++) advanceTurn(g, ['a','b','c'], 5000 + i, 'word');
  assert.equal(g.minLength, 10);
});
test('Pause à vide : une reconnexion conserve le temps restant, départ actif passe au suivant', () => {
  const g = game(['a']);
  reconcilePresence(g, [], 11000); assert.equal(g.deadlineAt, null); assert.equal(g.remainingMs, 5000);
  reconcilePresence(g, ['a'], 90000); assert.equal(g.deadlineAt, 95000);
  reconcilePresence(g, [], 92000); reconcilePresence(g, ['a'], 100000); assert.equal(g.deadlineAt, 103000);
  const multi = game(); reconcilePresence(multi, ['b'], 2000); assert.equal(multi.turnMemberId, 'b'); assert.equal(multi.deadlineAt, 17000);
});
test('Affichage : compensation du délai réseau et horloge locale monotone', () => {
  let time = 100;
  const clock = new GameClock(() => time);
  clock.sync(10000, 0, 100); // Aller-retour 100 ms : estime 50 ms pour le retour.
  assert.equal(clock.serverNow(), 10050);
  assert.equal(clock.remaining(25000), 14950);
  time = 1100; assert.equal(clock.remaining(25000), 13950);
  clock.sync(500000, 0, 1100); // Échantillon réseau trop lent : ignoré.
  assert.equal(clock.serverNow(), 11050);
  time = 20000; assert.equal(clock.remaining(25000), 0);
});
