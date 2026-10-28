const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { io: connect } = require('socket.io-client');
const { createGameServer } = require('../server');
const { iceConfiguration } = require('../lib/voice');
const { VoiceChat } = require('../public/voice');

const emit = (socket, event, data = {}) =>
  new Promise((resolve, reject) =>
    socket
      .timeout(3000)
      .emit(event, data, (error, value) => (error ? reject(error) : resolve(value))),
  );

test('TURN : identifiants temporaires, secret privé, configuration optionnelle et relais imposé', () => {
  const env = {
    TURN_URLS: 'turn:relay.example.com:3478,turns:relay.example.com:5349',
    TURN_SHARED_SECRET: 'private-server-secret',
    WEBRTC_RELAY_ONLY: '1',
  };
  const config = iceConfiguration(env, 1000000);
  const server = config.iceServers[1];
  assert.equal(config.iceTransportPolicy, 'relay');
  assert.equal(config.expiresAt, 4600000);
  assert.match(server.username, /^4600:/);
  assert.equal(
    server.credential,
    createHmac('sha1', env.TURN_SHARED_SECRET).update(server.username).digest('base64'),
  );
  assert.equal(JSON.stringify(config).includes(env.TURN_SHARED_SECRET), false);
  assert.equal(iceConfiguration({}).relayAvailable, false);
  assert.throws(() => iceConfiguration({ WEBRTC_RELAY_ONLY: '1' }), /TURN/);
  assert.equal(
    iceConfiguration({
      TURN_URLS: 'turn:relay.example.com',
      TURN_USERNAME: 'user',
      TURN_CREDENTIAL: 'pass',
    }).relayAvailable,
    true,
  );
});

test('Vocal serveur : isolation, sessions, modération, persistance et départ', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wcg-voice-'));
  const file = path.join(dir, 'rooms.json');
  const app = await createGameServer({
    dataFile: file,
    databaseUrl: '',
    allowLocalStore: true,
    voiceEnv: {},
  });
  const clients = [];
  t.after(async () => {
    await app.close();
    clients.forEach((c) => c.disconnect());
    rmSync(dir, { recursive: true, force: true });
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  async function client(name) {
    const socket = connect(`http://127.0.0.1:${app.server.address().port}`, {
      transports: ['websocket'],
      forceNew: true,
    });
    clients.push(socket);
    await once(socket, 'connect');
    socket.on('room:state', (room) => {
      socket.room = room;
    });
    socket.on('voice:state', (state) => {
      socket.voice = state;
    });
    socket.identity = { name, token: `${name}-private-browser-token-12345` };
    return socket;
  }
  const a = await client('Alice'),
    b = await client('Bob'),
    c = await client('Charlie');
  assert.match((await emit(c, 'voice:join')).error, /room/);
  await emit(a, 'room:create', a.identity);
  const code = a.room.code;
  await emit(b, 'room:join', { ...b.identity, code });
  await emit(c, 'room:create', c.identity);
  const av = await emit(a, 'voice:join', { muted: false });
  const bv = await emit(b, 'voice:join', { muted: false });
  const cv = await emit(c, 'voice:join');
  assert.equal(bv.state.participants.length, 2);
  assert.equal(cv.state.participants.length, 1);
  const bob = bv.state.participants.find((p) => p.id === b.id);
  const signal = {
    to: b.id,
    session: av.session,
    toSession: bv.session,
    description: { type: 'offer', sdp: 'v=0\r\n' },
  };
  const received = once(b, 'voice:signal');
  assert.equal((await emit(a, 'voice:signal', signal)).ok, true);
  assert.equal((await received)[0].from, a.id);
  assert.ok((await emit(c, 'voice:signal', { ...signal, session: cv.session })).error);
  assert.ok((await emit(a, 'voice:signal', { ...signal, session: 'forged-session' })).error);
  assert.ok(
    (
      await emit(a, 'voice:signal', {
        ...signal,
        description: { type: 'offer', sdp: 'x'.repeat(64001) },
      })
    ).error,
  );
  assert.ok(
    (await emit(a, 'voice:signal', { ...signal, description: { type: 'rollback', sdp: '' } }))
      .error,
  );
  assert.match(
    (await emit(b, 'voice:moderate', { memberId: bob.memberId, muted: true })).error,
    /hôte/,
  );
  assert.equal((await emit(a, 'voice:moderate', { memberId: bob.memberId, muted: true })).ok, true);
  await emit(b, 'voice:mute', { muted: false });
  const blocked = (await emit(b, 'voice:join')).state.participants.find((p) => p.id === b.id);
  assert.equal(blocked.hostMuted, true);
  assert.equal(blocked.muted, true);
  assert.ok(
    JSON.parse(readFileSync(file))
      .rooms.find((r) => r.code === code)
      .voiceMutedMembers.includes(bob.memberId),
  );
  await emit(b, 'voice:leave');
  const rejoined = await emit(b, 'voice:join', { muted: false });
  assert.notEqual(rejoined.session, bv.session);
  assert.equal(rejoined.state.participants.find((p) => p.id === b.id).hostMuted, true);
  assert.ok((await emit(a, 'voice:signal', signal)).error);
  await emit(a, 'voice:moderate', { memberId: bob.memberId, muted: false });
  // Lever la modération ne rallume pas le micro.
  assert.equal(
    (await emit(b, 'voice:join')).state.participants.find((p) => p.id === b.id).muted,
    true,
  );
  await emit(a, 'room:leave');
  assert.equal((await emit(b, 'voice:join')).state.host, b.id);
  assert.equal((await emit(b, 'voice:join')).state.participants.length, 1);
  assert.match((await emit(a, 'voice:config')).error, /room/);
  await emit(b, 'room:join', { ...b.identity, code: c.room.code });
  assert.equal((await emit(c, 'voice:join')).state.participants.length, 1);
});

function harness({ media } = {}) {
  const handlers = {},
    calls = [],
    tracks = [];
  let sequence = 0;
  const socket = {
    id: 'a',
    connected: true,
    on: (event, callback) => {
      handlers[event] = callback;
    },
    timeout() {
      return this;
    },
    emit(event, data, ack) {
      calls.push({ event, data });
      if (!ack) return;
      if (event === 'voice:join')
        ack(null, {
          session: 'self-session',
          iceServers: [],
          relayAvailable: false,
          expiresAt: Date.now() + 3600000,
          state: {
            code: 'ABC123',
            host: 'a',
            participants: [
              {
                id: 'a',
                session: 'self-session',
                memberId: 'alice',
                name: 'Alice',
                muted: data.muted,
              },
              { id: 'b', session: 'bob-session', memberId: 'bob', name: 'Bob', muted: false },
            ],
          },
        });
      else ack(null, { ok: true });
    },
  };
  class Peer {
    constructor() {
      this.connectionState = 'new';
      this.signalingState = 'stable';
      this.remoteDescription = null;
      this.candidates = [];
      this.sender = {
        track: null,
        replaceTrack: async (track) => {
          this.sender.track = track;
        },
        getParameters: () => ({ encodings: [{}] }),
        setParameters: async () => {},
      };
    }
    addTransceiver(track, options) {
      this.sender.track = typeof track === 'string' ? null : track;
      this.transceiver = {
        sender: this.sender,
        receiver: { track: { kind: 'audio' } },
        direction: options.direction,
      };
    }
    getTransceivers() {
      return [this.transceiver];
    }
    getSenders() {
      return [this.sender];
    }
    async setLocalDescription() {
      this.localDescription = {
        type: this.remoteDescription?.type === 'offer' ? 'answer' : 'offer',
        sdp: 'v=0',
      };
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }
    async addIceCandidate(candidate) {
      this.candidates.push(candidate);
    }
    async getStats() {
      return new Map();
    }
    setConfiguration() {}
    close() {
      this.closed = true;
    }
  }
  const stream = () => {
    const track = {
      id: ++sequence,
      kind: 'audio',
      enabled: true,
      stop() {
        this.stopped = true;
      },
    };
    tracks.push(track);
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  };
  const voice = new VoiceChat({
    socket,
    PeerConnection: Peer,
    mediaDevices: { getUserMedia: media || (async () => stream()) },
    makeAudio: () => ({ play: async () => {}, pause() {}, remove() {} }),
    makeStream: (tracks) => ({ getTracks: () => tracks }),
  });
  voice.setRoom({ code: 'ABC123', host: 'a' });
  return { voice, handlers, calls, tracks, stream };
}

test('Vocal client : permission volontaire, mute, écoute, blocage et mute imposé chez le destinataire', async (t) => {
  const { voice, tracks } = harness();
  t.after(() => voice.leave(false));
  assert.equal(tracks.length, 0);
  await voice.join();
  assert.equal(voice.active, true);
  assert.equal(tracks[0].enabled, true);
  const peer = voice.peers.get('b');
  peer.pc.ontrack({ streams: [{}] });
  assert.equal(peer.audio.muted, false);
  voice.toggleBlock('bob');
  assert.equal(peer.audio.muted, true);
  voice.toggleBlock('bob');
  assert.equal(peer.audio.muted, false);
  voice.toggleDeafen();
  assert.equal(peer.audio.muted, true);
  voice.toggleDeafen();
  assert.equal(peer.audio.muted, false);
  voice.receiveState({
    code: 'ABC123',
    host: 'a',
    participants: voice.participants.map((p) => ({ ...p, hostMuted: true })),
  });
  assert.equal(tracks[0].enabled, false);
  assert.equal(peer.audio.muted, true);
  voice.receiveState({
    code: 'ABC123',
    host: 'a',
    participants: voice.participants.map((p) => ({ ...p, hostMuted: false })),
  });
  assert.equal(tracks[0].enabled, false);
  await voice.toggleMute();
  assert.equal(tracks[0].enabled, true);
  await voice.toggleMute();
  assert.equal(tracks[0].enabled, false);
  voice.leave();
  assert.equal(tracks[0].stopped, true);
  assert.equal(peer.pc.closed, true);
  assert.equal(peer.audio.srcObject, null);
});

test('Vocal client : écoute seule sans permission et activation ultérieure du micro', async (t) => {
  const { voice, tracks } = harness();
  t.after(() => voice.leave(false));
  await voice.join(true);
  assert.equal(tracks.length, 0);
  assert.equal(voice.peers.get('b').pc.transceiver.direction, 'recvonly');
  await voice.toggleMute();
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].enabled, true);
  assert.equal(voice.peers.get('b').pc.transceiver.direction, 'sendrecv');
});

test('Vocal client : permission tardive après sortie et refus du micro', async () => {
  let grant;
  const { voice, stream, calls } = harness({
    media: () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  });
  const joining = voice.join();
  voice.leave();
  const lateStream = stream();
  grant(lateStream);
  await joining;
  assert.equal(lateStream.getTracks()[0].stopped, true);
  assert.equal(
    calls.some((c) => c.event === 'voice:join'),
    false,
  );
  const denied = harness({
    media: async () => {
      throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    },
  }).voice;
  await denied.join();
  assert.equal(denied.active, false);
  assert.match(denied.status, /Micro refusé/);
});

test('Vocal client : ICE avant SDP, offres simultanées et messages périmés', async (t) => {
  const { voice } = harness();
  t.after(() => voice.leave(false));
  await voice.join(true);
  const peer = voice.peers.get('b');
  const base = { code: 'ABC123', from: 'b', session: 'bob-session', toSession: 'self-session' };
  voice.receiveSignal({ ...base, candidate: { candidate: 'ice-before-offer' } });
  await peer.chain;
  assert.equal(peer.pc.candidates.length, 0);
  voice.receiveSignal({ ...base, description: { type: 'offer', sdp: 'v=0' } });
  await peer.chain;
  assert.equal(peer.pc.candidates.length, 1);
  voice.receiveSignal({ ...base, toSession: 'expired', candidate: { candidate: 'wrong-session' } });
  await peer.chain;
  assert.equal(peer.pc.candidates.length, 1);
  peer.makingOffer = true;
  peer.pc.signalingState = 'have-local-offer';
  peer.pc.remoteDescription = null;
  voice.receiveSignal({ ...base, description: { type: 'offer', sdp: 'collision' } });
  await peer.chain;
  assert.equal(peer.pc.remoteDescription, null); // a est impoli face à b.
  peer.polite = true;
  voice.receiveSignal({ ...base, description: { type: 'offer', sdp: 'polite-collision' } });
  await peer.chain;
  assert.equal(peer.pc.remoteDescription.sdp, 'polite-collision');
});

test('Vocal client : une activation interrompue ne réactive pas le micro après la sortie', async () => {
  let grant;
  const { voice, stream } = harness({
    media: () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  });
  await voice.join(true);
  const activating = voice.toggleMute();
  voice.leave();
  const lateStream = stream();
  grant(lateStream);
  await activating;
  assert.equal(lateStream.getTracks()[0].stopped, true);
  assert.equal(voice.stream, null);
  assert.equal(voice.active, false);
});

test('Vocal client : la levée du mute par l’hôte ne rallume pas un micro coupé côté serveur', async (t) => {
  const { voice, tracks } = harness();
  t.after(() => voice.leave(false));
  await voice.join();
  voice.muted = false; // Une réponse locale ancienne ne doit pas gagner contre l’état serveur.
  voice.receiveState({
    code: 'ABC123',
    host: 'a',
    participants: voice.participants.map((p) =>
      p.id === 'a' ? { ...p, muted: true, hostMuted: false } : p,
    ),
  });
  assert.equal(tracks[0].enabled, false);
  assert.equal(voice.muted, true);
});
