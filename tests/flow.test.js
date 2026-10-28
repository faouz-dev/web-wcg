const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function browser(initialName, pathname = '/', search = '') {
  const elements = new Map();
  const element = (key) => {
    if (!elements.has(key))
      elements.set(key, {
        hidden: false,
        value: '',
        textContent: '',
        children: [],
        style: { setProperty() {} },
        dataset: {},
        classList: { toggle() {} },
        focus() {},
        setAttribute() {},
        replaceChildren() {
          this.children = [];
        },
        append(...children) {
          this.children.push(...children);
        },
        setCustomValidity() {},
        reportValidity() {},
        querySelector: (selector) => element(key + ' ' + selector),
      });
    return elements.get(key);
  };
  const storage = new Map(initialName === undefined ? [] : [['wordchain-name', initialName]]);
  const calls = [];
  const handlers = {};
  const socket = {
    id: 'self',
    connected: true,
    on(event, callback) {
      handlers[event] = callback;
    },
    timeout() {
      return this;
    },
    emit(...args) {
      calls.push(args);
    },
  };
  const context = {
    GameSounds: require('../public/sounds').GameSounds,
    GameSoundEvents: require('../public/sounds').GameSoundEvents,
    VoiceChat: require('../public/voice').VoiceChat,
    addEventListener() {},
    GameClock: require('../public/clock').GameClock,
    performance,
    setInterval: () => 0,
    crypto: { randomUUID: () => 'test-identity-token-123456789' },
    URLSearchParams,
    history: { replaceState() {} },
    location: { search, pathname },
    io: () => socket,
    document: {
      querySelector: element,
      createElement: (tag) => element('generated-' + tag + '-' + elements.size),
      addEventListener() {},
    },
    localStorage: {
      getItem: (key) => storage.get(key),
      setItem: (key, value) => storage.set(key, value),
    },
    setTimeout,
    clearTimeout,
    FormData: class {
      constructor() {
        return new Map([['lang', 'fr']]);
      }
    },
  };
  vm.runInNewContext(fs.readFileSync('public/app.js', 'utf8'), context);
  return { element, storage, calls, handlers, socket };
}
test('Nouveau joueur : pseudo requis puis création avec le pseudo enregistré', () => {
  const { element, storage, calls } = browser();
  element('#choose-create').onclick();
  assert.equal(element('#nickname-form').hidden, false);
  assert.equal(element('#create-form').hidden, true);
  element('#nickname').value = '  Camille  ';
  element('#nickname-form').onsubmit({ preventDefault() {} });
  assert.equal(storage.get('wordchain-name'), 'Camille');
  assert.equal(element('#create-form').hidden, false);
  element('#create-form').onsubmit({ preventDefault() {} });
  assert.equal(calls[0][0], 'room:create');
  assert.equal(calls[0][1].name, 'Camille');
});
test('Pseudo existant : rejoindre directement, modifier et revenir à l’accueil', () => {
  const { element } = browser('Alex');
  element('#choose-join').onclick();
  assert.equal(element('#nickname-form').hidden, true);
  assert.equal(element('#join-form').hidden, false);
  assert.equal(element('#saved-name').textContent, 'Alex');
  element('#edit-name').onclick();
  assert.equal(element('#nickname-form').hidden, false);
  element('#nickname').value = 'Sam';
  element('#nickname-form').onsubmit({ preventDefault() {} });
  assert.equal(element('#join-form').hidden, false);
  assert.equal(element('#saved-name').textContent, 'Sam');
  element('#setup-back').onclick();
  assert.equal(element('#choice').hidden, false);
  assert.equal(element('#setup').hidden, true);
});

test('Lien de room : le code est prérempli et le pseudo reste demandé si absent', () => {
  const { element } = browser(undefined, '/room/abc123');
  assert.equal(element('#join-form input[name=code]').value, 'ABC123');
  assert.equal(element('#nickname-form').hidden, false);
  element('#nickname').value = 'Camille';
  element('#nickname-form').onsubmit({ preventDefault() {} });
  assert.equal(element('#join-form').hidden, false);
});
test('Ancien lien avec paramètre conservé', () => {
  const { element } = browser('Alex', '/', '?room=ABC123');
  assert.equal(element('#join-form input[name=code]').value, 'ABC123');
  assert.equal(element('#join-form').hidden, false);
});

test('Partie observée : saisie cachée, joueur suivant visible et scores dans la barre latérale', () => {
  const { element, handlers, socket } = browser('Alex');
  const room = {
    code: 'ABC123',
    lang: 'fr',
    expiresAt: Date.now() + 100000,
    started: true,
    serverTime: Date.now(),
    deadlineAt: Date.now() + 15000,
    turnDuration: 15000,
    turnId: 'turn-one',
    turn: 'other',
    nextTurn: 'self',
    host: 'other',
    round: 2,
    minLength: 4,
    letter: 'e',
    games: [],
    rankings: [],
    history: [],
    players: [
      { id: 'other', memberId: 'camille', name: 'Camille', score: 12 },
      { id: 'self', memberId: 'alex', name: 'Alex', score: 3 },
    ],
    currentScores: [
      { memberId: 'camille', name: 'Camille', score: 12, connected: true, current: true },
      { memberId: 'alex', name: 'Alex', score: 3, connected: true, next: true },
    ],
  };
  handlers['room:state'](room);
  assert.equal(element('#word-form').hidden, true);
  assert.equal(element('#spectator-note').hidden, false);
  assert.match(element('#spectator-note').textContent, /Camille/);
  assert.match(element('#next-turn-label').textContent, /toi/);
  assert.equal(element('#players').children.length, 2);
  assert.equal(element('#players').children[0].children[2].textContent, '12 pt');
  element('#tab-stats').onclick();
  assert.equal(element('#panel-stats').hidden, false);
  assert.equal(element('#panel-play').hidden, true);
  handlers['room:state']({ ...room, turnId: 'turn-two', turn: 'self', nextTurn: 'other' });
  assert.equal(element('#word-form').hidden, false);
  assert.equal(element('#word').disabled, false);
  assert.equal(element('#spectator-note').hidden, true);
  assert.equal(element('#panel-stats').hidden, false);
  handlers['room:state']({
    ...room,
    turnId: 'turn-three',
    players: room.players.map((player) => ({ ...player, spectator: player.id === 'self' })),
    currentScores: [room.currentScores[0]],
    nextTurn: 'other',
  });
  assert.equal(element('#word-form').hidden, true);
  assert.match(element('#spectator-note').textContent, /Tu assistes/);
  assert.equal(element('#spectators').children.length, 1);
  assert.equal(element('#players').children.length, 1);
  socket.connected = false;
  handlers.disconnect();
  assert.equal(element('#word-form').hidden, true);
});
