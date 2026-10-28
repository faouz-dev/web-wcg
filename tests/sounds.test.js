const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameSounds, GameSoundEvents } = require('../public/sounds');
function audio() {
  const contexts = [];
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
    linearRampToValueAtTime() {},
    setTargetAtTime(value) {
      this.value = value;
    },
  });
  class Context {
    constructor() {
      this.currentTime = 0;
      this.state = 'suspended';
      this.destination = {};
      this.oscillators = [];
      contexts.push(this);
    }
    async resume() {
      this.state = 'running';
    }
    createGain() {
      return { gain: param(), connect() {}, disconnect() {} };
    }
    createOscillator() {
      const node = {
        frequency: param(),
        connect() {},
        disconnect() {},
        start() {
          this.started = true;
        },
        stop() {
          this.stops = (this.stops || 0) + 1;
        },
      };
      this.oscillators.push(node);
      return node;
    }
  }
  const saved = new Map();
  const storage = {
    getItem: (key) => saved.get(key),
    setItem: (key, value) => saved.set(key, value),
  };
  let visible = true;
  const sounds = new GameSounds({ AudioContextClass: Context, storage, visible: () => visible });
  return { sounds, contexts, storage, saved, hide: () => (visible = false) };
}
test('Audio : pas de contexte ni de son avant une interaction, puis synthèse disponible', async () => {
  const { sounds, contexts } = audio();
  assert.equal(contexts.length, 0);
  assert.equal(sounds.play('turn'), false);
  assert.equal(await sounds.unlock(), true);
  assert.equal(contexts.length, 1);
  assert.equal(sounds.play('accepted'), true);
  assert.equal(contexts[0].oscillators.length, 2);
  assert.ok(contexts[0].oscillators.every((node) => node.started));
  assert.equal(sounds.play('invalid'), false);
});
test('Audio : couper le son arrête les notes programmées et mémorise la préférence', async () => {
  const { sounds, contexts, storage } = audio();
  await sounds.unlock();
  sounds.play('victory');
  const nodes = [...contexts[0].oscillators];
  sounds.setEnabled(false);
  assert.equal(sounds.voices.size, 0);
  assert.ok(nodes.every((node) => node.stops === 2));
  assert.equal(sounds.play('tick'), false);
  const restored = new GameSounds({ storage });
  assert.equal(restored.enabled, false);
  assert.equal(restored.volume, 0.25);
});
test('Audio : volume borné et onglet masqué silencieux, sans erreur si Web Audio manque', async () => {
  const { sounds, hide } = audio();
  sounds.setVolume(10);
  assert.equal(sounds.volume, 0.6);
  sounds.setVolume(-1);
  assert.equal(sounds.volume, 0);
  sounds.setVolume(NaN);
  assert.equal(sounds.volume, 0);
  sounds.setVolume(0.2);
  await sounds.unlock();
  hide();
  assert.equal(sounds.play('turn'), false);
  const unavailable = new GameSounds({
    AudioContextClass: undefined,
    storage: {
      getItem() {
        throw new Error('storage blocked');
      },
    },
  });
  assert.equal(await unavailable.unlock(), false);
  assert.equal(unavailable.play('turn'), false);
});
function state(overrides = {}) {
  return {
    code: 'ABC123',
    started: false,
    turnId: null,
    turn: 'self',
    players: [
      { id: 'self', memberId: 'a' },
      { id: 'other', memberId: 'b' },
    ],
    history: [],
    games: [],
    ...overrides,
  };
}
test('Événements : tour, mot accepté, pas de répétition sur les mises à jour et reconnexions', () => {
  const played = [];
  const events = new GameSoundEvents((name) => played.push(name));
  events.onState(state(), 'self');
  let room = state({ started: true, turnId: 'one' });
  events.onState(room, 'self');
  events.onState(room, 'self');
  assert.deepEqual(played, ['turn']);
  room = state({
    started: true,
    turnId: 'two',
    turn: 'other',
    history: [{ word: 'ami', memberId: 'a' }],
  });
  events.onState(room, 'self');
  assert.deepEqual(played, ['turn', 'accepted']);
  room = state({
    started: true,
    turnId: 'three',
    history: [...room.history, { word: 'image', memberId: 'b' }],
  });
  events.onState(room, 'self');
  assert.deepEqual(played, ['turn', 'accepted', 'turn']);
  events.reset();
  events.onState(room, 'self');
  assert.equal(played.length, 3);
});
test('Événements : trois ticks maximum à 5, 3, 1 secondes, seulement pour le joueur actif', () => {
  const played = [];
  const events = new GameSoundEvents((name) => played.push(name));
  const room = state({ started: true, turnId: 'one' });
  [15000, 5000, 4900, 4000, 3000, 2800, 1000, 900, 0].forEach((ms) =>
    events.tick(room, 'self', ms, true),
  );
  assert.deepEqual(played, ['tick', 'tick', 'tick']);
  events.tick({ ...room, turnId: 'two', turn: 'other' }, 'self', 6000, true);
  events.tick({ ...room, turnId: 'two', turn: 'other' }, 'self', 5000, true);
  assert.equal(played.length, 3);
});
test('Événements : élimination et résultat de fin de partie une seule fois', () => {
  const played = [];
  const events = new GameSoundEvents((name) => played.push(name));
  const active = state({ started: true, turnId: 'one' });
  events.onState(active, 'self');
  const eliminated = state({
    started: true,
    turnId: 'two',
    turn: 'other',
    players: [
      { id: 'self', memberId: 'a', eliminated: true, spectator: true },
      { id: 'other', memberId: 'b' },
    ],
  });
  events.onState(eliminated, 'self');
  events.onState(eliminated, 'self');
  assert.deepEqual(played, ['eliminated']);
  const ended = state({ games: [{ results: [{ memberId: 'a', winner: false }] }] });
  events.onState(ended, 'self');
  events.onState(ended, 'self');
  assert.deepEqual(played, ['eliminated', 'finish']);
  events.reset();
  events.onState(active, 'self');
  events.onState(state({ games: [{ results: [{ memberId: 'a', winner: true }] }] }), 'self');
  assert.equal(played.at(-1), 'victory');
});
test('Événements : rejoindre une partie existante ne rejoue pas ses sons', () => {
  const played = [];
  const events = new GameSoundEvents((name) => played.push(name));
  events.onState(
    state({ started: true, turnId: 'existing', history: [{ word: 'ami', memberId: 'a' }] }),
    'self',
  );
  assert.equal(played.length, 0);
});
