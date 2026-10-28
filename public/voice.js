/* Audio natif WebRTC : aucun flux audio ne passe par Socket.IO. */
class VoiceChat {
  constructor({
    socket,
    onChange = () => {},
    onError = () => {},
    mediaDevices = globalThis.navigator?.mediaDevices,
    PeerConnection = globalThis.RTCPeerConnection,
    makeAudio = () => {
      const audio = document.createElement('audio');
      audio.hidden = true;
      document.body.append(audio);
      return audio;
    },
    makeStream = (tracks) => new MediaStream(tracks),
  }) {
    Object.assign(this, {
      socket,
      onChange,
      onError,
      mediaDevices,
      PeerConnection,
      makeAudio,
      makeStream,
    });
    this.available = Boolean(mediaDevices?.getUserMedia && PeerConnection);
    this.peers = new Map();
    this.blocked = new Set();
    this.participants = [];
    this.active = false;
    this.pending = false;
    this.muted = true;
    this.deafened = false;
    this.generation = 0;
    this.queued = [];
    this.status = '';
    socket.on('voice:state', (state) => this.receiveState(state));
    socket.on('voice:signal', (signal) => {
      if (this.pending) {
        if (this.queued.length < 100) this.queued.push(signal);
      } else this.receiveSignal(signal);
    });
  }
  change() {
    this.onChange(this);
  }
  request(event, data = {}) {
    return new Promise((resolve, reject) =>
      this.socket.timeout(8000).emit(event, data, (error, result) => {
        if (error || result?.error)
          reject(new Error(result?.error || 'Le serveur vocal ne répond pas.'));
        else resolve(result);
      }),
    );
  }
  setRoom(room) {
    if (this.code !== room.code) {
      this.leave();
      this.participants = [];
      this.code = room.code;
      this.blocked.clear();
    }
    this.host = room.host;
    this.change();
  }
  receiveState(state) {
    if (state.code !== this.code) return;
    this.host = state.host;
    this.participants = state.participants;
    const self = this.participants.find((p) => p.id === this.socket.id);
    if (self?.hostMuted || self?.muted) this.muted = true;
    this.applyMicrophone();
    if (this.active) this.reconcile();
    this.change();
  }
  async join(listenOnly = false) {
    if (!this.available || this.pending || this.active || !this.code || !this.socket.connected)
      return;
    const generation = ++this.generation;
    this.pending = true;
    this.status = listenOnly ? 'Connexion à l’écoute…' : 'Autorise ton micro…';
    this.change();
    let stream;
    try {
      // Une permission tardive ne doit jamais rouvrir le micro après avoir quitté la room.
      if (!listenOnly)
        stream = await this.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
      if (generation !== this.generation) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      this.watchStream(stream);
      this.muted =
        listenOnly || Boolean(this.participants.find((p) => p.id === this.socket.id)?.hostMuted);
      this.applyMicrophone();
      const result = await this.request('voice:join', { muted: this.muted });
      if (generation !== this.generation) return;
      this.session = result.session;
      this.config = {
        iceServers: result.iceServers,
        iceTransportPolicy: result.iceTransportPolicy,
      };
      this.relayAvailable = result.relayAvailable;
      this.active = true;
      this.pending = false;
      this.status = '';
      this.receiveState(result.state);
      this.scheduleConfig(result.expiresAt);
      this.meter = setInterval(() => this.updateLevels(), 350);
      for (const signal of this.queued.splice(0)) this.receiveSignal(signal);
      this.change();
    } catch (error) {
      stream?.getTracks().forEach((t) => t.stop());
      if (generation !== this.generation) return;
      this.leave();
      const message =
        error.name === 'NotAllowedError'
          ? 'Micro refusé. Autorise-le dans ton navigateur, ou choisis « Écouter ».'
          : error.name === 'NotFoundError'
            ? 'Aucun micro trouvé. Tu peux rejoindre en écoute seule.'
            : error.message;
      this.status = message;
      this.onError(message);
      this.change();
    }
  }
  scheduleConfig(expiresAt) {
    clearTimeout(this.configTimer);
    const generation = this.generation;
    this.configTimer = setTimeout(
      async () => {
        try {
          const result = await this.request('voice:config');
          if (!this.active || generation !== this.generation) return;
          this.config = {
            iceServers: result.iceServers,
            iceTransportPolicy: result.iceTransportPolicy,
          };
          for (const peer of this.peers.values()) {
            peer.pc.setConfiguration(this.config);
            peer.pc.restartIce();
          }
          this.scheduleConfig(result.expiresAt);
        } catch {
          if (this.active && generation === this.generation)
            this.scheduleConfig(Date.now() + 90000);
        }
      },
      Math.max(30000, (expiresAt || Date.now() + 3600000) - Date.now() - 60000),
    );
  }
  watchStream(stream) {
    const generation = this.generation;
    for (const track of stream?.getAudioTracks() || [])
      track.addEventListener?.(
        'ended',
        () => {
          if (generation !== this.generation || this.stream !== stream) return;
          this.stream = null;
          this.muted = true;
          stream.getTracks().forEach((t) => t.stop());
          this.request('voice:mute', { muted: true }).catch(() => {});
          this.status = 'Micro déconnecté. Tu peux le réactiver pour réessayer.';
          this.change();
        },
        { once: true },
      );
  }
  applyMicrophone() {
    const hostMuted = this.participants.find((p) => p.id === this.socket.id)?.hostMuted;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted && !hostMuted;
    });
  }
  async toggleMute() {
    if (!this.active || this.micPending) return;
    const self = this.participants.find((p) => p.id === this.socket.id);
    if (self?.hostMuted) return this.onError('Ton micro est coupé par l’hôte.');
    const generation = this.generation;
    this.micPending = true;
    this.change();
    let acquired;
    try {
      if (!this.stream) {
        acquired = await this.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false,
        });
        if (generation !== this.generation) {
          acquired.getTracks().forEach((t) => t.stop());
          return;
        }
        this.stream = acquired;
        this.watchStream(acquired);
        // Les pistes restent coupées tant que le serveur n’a pas autorisé la publication.
        this.stream.getTracks().forEach((t) => {
          t.enabled = false;
        });
        for (const peer of this.peers.values()) {
          const transceiver = peer.pc
            .getTransceivers()
            .find((t) => t.receiver.track.kind === 'audio');
          if (transceiver) {
            await transceiver.sender.replaceTrack(this.stream.getAudioTracks()[0]);
            transceiver.direction = 'sendrecv';
          }
        }
      }
      if (generation !== this.generation) return;
      const muted = !this.muted;
      const result = await this.request('voice:mute', { muted });
      if (generation !== this.generation) return;
      this.muted = result.muted ?? muted;
      this.applyMicrophone();
    } catch (error) {
      if (generation !== this.generation) return;
      this.muted = true;
      this.applyMicrophone();
      this.onError(error.message);
    } finally {
      if (generation === this.generation) {
        this.micPending = false;
        this.change();
      }
    }
  }
  toggleDeafen() {
    this.deafened = !this.deafened;
    for (const peer of this.peers.values()) this.applyAudio(peer);
    this.change();
  }
  toggleBlock(memberId) {
    if (this.blocked.has(memberId)) this.blocked.delete(memberId);
    else this.blocked.add(memberId);
    for (const peer of this.peers.values()) this.applyAudio(peer);
    this.change();
  }
  async moderate(memberId, muted) {
    try {
      await this.request('voice:moderate', { memberId, muted });
    } catch (error) {
      this.onError(error.message);
    }
  }
  reconcile() {
    for (const [id, peer] of this.peers) {
      const participant = this.participants.find((p) => p.id === id && p.session === peer.session);
      if (!participant) this.closePeer(id);
    }
    for (const participant of this.participants) {
      if (participant.id === this.socket.id) continue;
      if (!this.peers.has(participant.id)) this.createPeer(participant);
      this.applyAudio(this.peers.get(participant.id));
    }
  }
  signal(peer, payload) {
    if (!this.active || this.peers.get(peer.id) !== peer) return;
    this.request('voice:signal', {
      to: peer.id,
      session: this.session,
      toSession: peer.session,
      ...payload,
    }).catch(() => {});
  }
  createPeer(participant) {
    const pc = new this.PeerConnection(this.config);
    const peer = {
      id: participant.id,
      memberId: participant.memberId,
      session: participant.session,
      pc,
      polite: this.socket.id > participant.id,
      makingOffer: false,
      settingAnswer: false,
      ignoreOffer: false,
      candidates: [],
      retries: 0,
      chain: Promise.resolve(),
      speaking: false,
    };
    this.peers.set(peer.id, peer);
    pc.addTransceiver(this.stream?.getAudioTracks()[0] || 'audio', {
      direction: this.stream ? 'sendrecv' : 'recvonly',
      ...(this.stream ? { streams: [this.stream] } : {}),
    });
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(peer, {
          description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        });
      } catch {
        if (this.active) this.status = 'Connexion audio en cours de rétablissement…';
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(peer, { candidate: candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      if (event.track && event.track.kind !== 'audio') {
        event.track.stop();
        return;
      }
      if (this.peers.get(peer.id) !== peer) return;
      if (!peer.audio) {
        peer.audio = this.makeAudio();
        peer.audio.autoplay = true;
        peer.audio.playsInline = true;
      }
      peer.audio.srcObject = event.streams[0] || this.makeStream([event.track]);
      this.applyAudio(peer);
      this.play(peer);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        peer.retries = 0;
        clearTimeout(peer.retryTimer);
        this.limitBitrate(peer);
      } else if (['failed', 'disconnected'].includes(pc.connectionState)) {
        clearTimeout(peer.retryTimer);
        peer.retryTimer = setTimeout(
          () => {
            if (this.peers.get(peer.id) !== peer || pc.connectionState === 'connected') return;
            if (peer.retries++ < 2) pc.restartIce();
            else {
              this.status = 'Un ami est injoignable. Quitter puis réactiver le vocal peut aider.';
              this.change();
            }
          },
          pc.connectionState === 'failed' ? 1000 : 5000,
        );
      }
      this.change();
    };
    return peer;
  }
  async limitBitrate(peer) {
    try {
      const sender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (!sender) return;
      const parameters = sender.getParameters();
      if (!parameters.encodings?.length) parameters.encodings = [{}];
      parameters.encodings[0].maxBitrate = 32000;
      await sender.setParameters(parameters);
    } catch {
      /* Certains navigateurs ne permettent pas ce réglage. */
    }
  }
  receiveSignal(signal) {
    if (!this.active || signal.code !== this.code || signal.toSession !== this.session) return;
    const participant = this.participants.find(
      (p) => p.id === signal.from && p.session === signal.session,
    );
    if (!participant) return;
    const peer = this.peers.get(signal.from) || this.createPeer(participant);
    peer.chain = peer.chain
      .then(async () => {
        if (this.peers.get(peer.id) !== peer) return;
        const pc = peer.pc;
        if (signal.description) {
          const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingAnswer);
          const collision = signal.description.type === 'offer' && !ready;
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return;
          peer.settingAnswer = signal.description.type === 'answer';
          await pc.setRemoteDescription(signal.description);
          peer.settingAnswer = false;
          for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
          if (signal.description.type === 'offer') {
            await pc.setLocalDescription();
            this.signal(peer, {
              description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          }
        } else if (signal.candidate && !peer.ignoreOffer) {
          if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
          else if (peer.candidates.length < 100) peer.candidates.push(signal.candidate);
        }
      })
      .catch(() => {
        peer.settingAnswer = false;
      });
  }
  applyAudio(peer) {
    if (!peer?.audio) return;
    const participant = this.participants.find((p) => p.id === peer.id);
    // Le mute de l’hôte est appliqué chez chaque destinataire, même si l’émetteur modifie son client.
    peer.audio.muted =
      this.deafened ||
      this.blocked.has(peer.memberId) ||
      !participant ||
      participant.hostMuted ||
      participant.muted;
  }
  play(peer) {
    try {
      const playing = peer.audio?.play();
      playing?.catch(() => {
        if (this.active && this.peers.get(peer.id) === peer) {
          this.playbackBlocked = true;
          this.change();
        }
      });
    } catch {
      this.playbackBlocked = true;
      this.change();
    }
  }
  unlockPlayback() {
    this.playbackBlocked = false;
    for (const peer of this.peers.values()) this.play(peer);
    this.change();
  }
  async updateLevels() {
    if (this.meterBusy || !this.active) return;
    const generation = this.generation;
    this.meterBusy = true;
    try {
      let selfSpeaking = false;
      await Promise.all(
        [...this.peers.values()].map(async (peer) => {
          try {
            const stats = await peer.pc.getStats();
            let speaking = false;
            stats.forEach((report) => {
              if (
                report.type === 'inbound-rtp' &&
                (report.kind === 'audio' || report.mediaType === 'audio')
              )
                speaking ||= report.audioLevel > 0.025;
              if (report.type === 'media-source' && report.kind === 'audio')
                selfSpeaking ||= report.audioLevel > 0.025;
            });
            peer.speaking = speaking && !peer.audio?.muted;
          } catch {}
        }),
      );
      if (generation === this.generation) {
        this.speaking = selfSpeaking && !this.muted;
        this.change();
      }
    } finally {
      this.meterBusy = false;
    }
  }
  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.retryTimer);
    peer.pc.onnegotiationneeded =
      peer.pc.onicecandidate =
      peer.pc.ontrack =
      peer.pc.onconnectionstatechange =
        null;
    peer.pc.close();
    if (peer.audio) {
      peer.audio.pause();
      peer.audio.srcObject = null;
      peer.audio.remove?.();
    }
  }
  leave(notify = true) {
    ++this.generation;
    if (notify && (this.active || this.pending) && this.socket.connected)
      this.socket.emit('voice:leave', {});
    this.active = this.pending = this.micPending = false;
    clearTimeout(this.configTimer);
    clearInterval(this.meter);
    for (const id of this.peers.keys()) this.closePeer(id);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.session = null;
    this.queued = [];
    this.muted = true;
    this.speaking = false;
    this.status = '';
    this.playbackBlocked = false;
    this.change();
  }
}
if (typeof module !== 'undefined') module.exports = { VoiceChat };
