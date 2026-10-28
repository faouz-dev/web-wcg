const { randomUUID, createHmac } = require('node:crypto');

function iceConfiguration(env = process.env, now = Date.now()) {
  const urls = (value, pattern) =>
    String(value || '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => pattern.test(v));
  const stun = urls(env.WEBRTC_STUN_URLS ?? 'stun:stun.l.google.com:19302', /^stuns?:[^\s]+$/);
  const turn = urls(env.TURN_URLS, /^turns?:[^\s]+$/);
  const iceServers = stun.length ? [{ urls: stun }] : [];
  const expiresAt = now + 3600000;
  if (turn.length && env.TURN_SHARED_SECRET) {
    const username = `${Math.floor(expiresAt / 1000)}:${randomUUID()}`;
    iceServers.push({
      urls: turn,
      username,
      credential: createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64'),
    });
  } else if (turn.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
  }
  const relayAvailable = iceServers.some((server) => server.credential);
  if (env.WEBRTC_RELAY_ONLY === '1' && !relayAvailable)
    throw new Error('TURN manquant pour le mode relais.');
  return {
    iceServers,
    iceTransportPolicy: env.WEBRTC_RELAY_ONLY === '1' ? 'relay' : 'all',
    relayAvailable,
    expiresAt,
  };
}

function createVoice({ io, rooms, presence, hostId, store, env = process.env }) {
  const sessions = new Map();
  const group = (code) => [...sessions.values()].filter((peer) => peer.code === code);
  const state = (code) => {
    const room = rooms.get(code);
    return {
      code,
      host: room ? hostId(room) : null,
      participants: group(code).map((peer) => ({
        id: peer.id,
        session: peer.session,
        memberId: peer.memberId,
        name: room?.members[peer.memberId]?.name || '',
        muted: peer.muted,
        hostMuted: Boolean(room?.voiceMutedMembers?.includes(peer.memberId)),
      })),
    };
  };
  const broadcast = (code) => {
    if (code) io.to(code).emit('voice:state', state(code));
  };
  const leave = (socket) => {
    const peer = sessions.get(socket.id);
    sessions.delete(socket.id);
    if (peer) broadcast(peer.code);
  };
  function attach(socket) {
    let windowAt = 0,
      events = 0;
    function handle(event, callback) {
      socket.on(event, async (data, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        try {
          if (Date.now() - windowAt > 10000) {
            windowAt = Date.now();
            events = 0;
          }
          if (++events > 240)
            return ack({ error: 'Trop de demandes vocales. Réessaie dans quelques secondes.' });
          const room = rooms.get(socket.data.code);
          if (!room || presence.get(room.code)?.get(socket.data.memberId) !== socket.id)
            return ack({ error: 'Rejoins une room avant le vocal.' });
          await callback(data || {}, room, ack);
        } catch {
          ack({ error: 'Vocal momentanément indisponible.' });
        }
      });
    }
    handle('voice:join', (data, room, ack) => {
      const config = iceConfiguration(env);
      if (!sessions.has(socket.id))
        sessions.set(socket.id, {
          id: socket.id,
          code: room.code,
          memberId: socket.data.memberId,
          session: randomUUID(),
          muted:
            data.muted !== false || Boolean(room.voiceMutedMembers?.includes(socket.data.memberId)),
        });
      ack({
        ok: true,
        ...config,
        state: state(room.code),
        session: sessions.get(socket.id).session,
      });
      broadcast(room.code);
    });
    handle('voice:leave', (data, room, ack) => {
      leave(socket);
      ack({ ok: true });
    });
    handle('voice:config', (data, room, ack) => {
      if (!sessions.has(socket.id)) return ack({ error: 'Vocal inactif.' });
      ack(iceConfiguration(env));
    });
    handle('voice:mute', (data, room, ack) => {
      const peer = sessions.get(socket.id);
      if (!peer) return ack({ error: 'Vocal inactif.' });
      peer.muted = data.muted !== false || Boolean(room.voiceMutedMembers?.includes(peer.memberId));
      broadcast(room.code);
      ack({ ok: true, muted: peer.muted });
    });
    handle('voice:moderate', async (data, room, ack) => {
      if (hostId(room) !== socket.id) return ack({ error: 'Seul l’hôte peut modérer le vocal.' });
      if (
        typeof data.memberId !== 'string' ||
        !Object.hasOwn(room.members, data.memberId) ||
        typeof data.muted !== 'boolean'
      )
        return ack({ error: 'Joueur invalide.' });
      const muted = new Set(room.voiceMutedMembers || []);
      if (data.muted) muted.add(data.memberId);
      else muted.delete(data.memberId);
      room.voiceMutedMembers = [...muted];
      for (const peer of group(room.code))
        if (peer.memberId === data.memberId && data.muted) peer.muted = true;
      store.save();
      await store.flush?.();
      broadcast(room.code);
      ack({ ok: true });
    });
    handle('voice:signal', (data, room, ack) => {
      const sender = sessions.get(socket.id),
        target = sessions.get(data.to);
      if (
        !sender ||
        !target ||
        sender.id === target.id ||
        sender.code !== target.code ||
        sender.code !== room.code ||
        sender.session !== data.session ||
        target.session !== data.toSession
      )
        return ack({ error: 'Connexion vocale expirée ou non autorisée.' });
      let payload;
      if (
        data.description &&
        ['offer', 'answer'].includes(data.description.type) &&
        typeof data.description.sdp === 'string' &&
        data.description.sdp.length <= 64000 &&
        !/^m=(?!audio )/m.test(data.description.sdp)
      ) {
        payload = { description: { type: data.description.type, sdp: data.description.sdp } };
      } else if (
        data.candidate &&
        typeof data.candidate.candidate === 'string' &&
        data.candidate.candidate.length <= 4096 &&
        (data.candidate.sdpMid == null ||
          (typeof data.candidate.sdpMid === 'string' && data.candidate.sdpMid.length <= 128)) &&
        (data.candidate.sdpMLineIndex == null || Number.isInteger(data.candidate.sdpMLineIndex))
      ) {
        payload = {
          candidate: {
            candidate: data.candidate.candidate,
            sdpMid: data.candidate.sdpMid ?? null,
            sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
            usernameFragment:
              typeof data.candidate.usernameFragment === 'string'
                ? data.candidate.usernameFragment.slice(0, 256)
                : undefined,
          },
        };
      } else return ack({ error: 'Signal vocal invalide.' });
      io.to(target.id).emit('voice:signal', {
        code: room.code,
        from: sender.id,
        session: sender.session,
        toSession: target.session,
        ...payload,
      });
      ack({ ok: true });
    });
  }
  return { attach, leave, broadcast };
}
module.exports = { createVoice, iceConfiguration };
