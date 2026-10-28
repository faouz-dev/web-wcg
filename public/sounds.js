// Bruitages originaux synthétisés : aucun fichier audio ni service externe.
const SOUND_PATTERNS = {
  preview: [[523, 660, 0, 0.12, 0.22, 'sine']],
  start: [
    [392, 392, 0, 0.12, 0.18, 'triangle'],
    [523, 523, 0.12, 0.18, 0.2, 'sine'],
  ],
  turn: [
    [523, 523, 0, 0.1, 0.24, 'triangle'],
    [784, 784, 0.11, 0.16, 0.2, 'sine'],
  ],
  accepted: [
    [440, 760, 0, 0.08, 0.2, 'sine'],
    [880, 1046, 0.065, 0.12, 0.15, 'sine'],
  ],
  rejected: [[240, 180, 0, 0.14, 0.2, 'sine']],
  tick: [[840, 420, 0, 0.045, 0.14, 'sine']],
  eliminated: [
    [392, 350, 0, 0.12, 0.2, 'triangle'],
    [294, 262, 0.12, 0.14, 0.17, 'sine'],
    [196, 180, 0.25, 0.16, 0.12, 'sine'],
  ],
  finish: [
    [392, 392, 0, 0.12, 0.17, 'sine'],
    [523, 523, 0.13, 0.18, 0.17, 'triangle'],
    [659, 659, 0.3, 0.22, 0.12, 'sine'],
  ],
  victory: [
    [523, 523, 0, 0.12, 0.2, 'triangle'],
    [659, 659, 0.1, 0.12, 0.18, 'triangle'],
    [784, 784, 0.2, 0.13, 0.18, 'sine'],
    [1046, 1046, 0.34, 0.24, 0.15, 'sine'],
  ],
};
class GameSounds {
  constructor({
    storage,
    AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
    visible = () => !globalThis.document?.hidden,
  } = {}) {
    this.storage = storage;
    if (this.storage === undefined) {
      try {
        this.storage = globalThis.localStorage;
      } catch {}
    }
    this.AudioContextClass = AudioContextClass;
    this.visible = visible;
    this.enabled = true;
    this.volume = 0.25;
    this.context = null;
    this.master = null;
    this.voices = new Set();
    try {
      const saved = JSON.parse(this.storage?.getItem('wordchain-audio') || 'null');
      if (typeof saved?.enabled === 'boolean') this.enabled = saved.enabled;
      if (typeof saved?.volume === 'number' && Number.isFinite(saved.volume))
        this.volume = Math.min(0.6, Math.max(0, saved.volume));
    } catch {}
  }
  get available() {
    return typeof this.AudioContextClass === 'function';
  }
  save() {
    try {
      this.storage?.setItem(
        'wordchain-audio',
        JSON.stringify({ enabled: this.enabled, volume: this.volume }),
      );
    } catch {}
  }
  async unlock() {
    if (!this.available || !this.enabled || !this.visible()) return false;
    try {
      if (!this.context || this.context.state === 'closed') {
        this.context = new this.AudioContextClass();
        this.master = this.context.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.context.destination);
      }
      if (this.context.state === 'suspended' || this.context.state === 'interrupted')
        await this.context.resume();
      return this.context.state === 'running';
    } catch {
      return false;
    }
  }
  setEnabled(value) {
    this.enabled = Boolean(value);
    if (!this.enabled) this.stop();
    this.applyVolume();
    this.save();
  }
  setVolume(value) {
    if (!Number.isFinite(value)) return;
    this.volume = Math.min(0.6, Math.max(0, value));
    if (this.volume === 0) this.stop();
    this.applyVolume();
    this.save();
  }
  applyVolume() {
    if (!this.master || !this.context) return;
    try {
      this.master.gain.setTargetAtTime(
        this.enabled ? this.volume : 0,
        this.context.currentTime,
        0.015,
      );
    } catch {}
  }
  stop() {
    for (const voice of this.voices) {
      try {
        voice.oscillator.stop();
      } catch {}
      voice.oscillator.disconnect();
      voice.envelope.disconnect();
    }
    this.voices.clear();
  }
  play(name) {
    if (
      !this.enabled ||
      this.volume === 0 ||
      !this.visible() ||
      this.context?.state !== 'running' ||
      !SOUND_PATTERNS[name]
    )
      return false;
    try {
      // Une seule petite séquence à la fois, pour éviter les superpositions lors des transitions.
      this.stop();
      const time = this.context.currentTime + 0.008;
      for (const [frequency, end, offset, length, level, type] of SOUND_PATTERNS[name]) {
        const oscillator = this.context.createOscillator();
        const envelope = this.context.createGain();
        const start = time + offset;
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, start);
        oscillator.frequency.exponentialRampToValueAtTime(end, start + length);
        envelope.gain.setValueAtTime(0.0001, start);
        envelope.gain.linearRampToValueAtTime(level, start + 0.006);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + length);
        oscillator.connect(envelope);
        envelope.connect(this.master);
        const voice = { oscillator, envelope };
        this.voices.add(voice);
        oscillator.onended = () => {
          this.voices.delete(voice);
          oscillator.disconnect();
          envelope.disconnect();
        };
        oscillator.start(start);
        oscillator.stop(start + length + 0.02);
      }
      return true;
    } catch {
      this.stop();
      return false;
    }
  }
}
class GameSoundEvents {
  constructor(play) {
    this.play = play;
    this.previous = null;
    this.previousTick = null;
  }
  reset() {
    this.previous = null;
    this.previousTick = null;
  }
  onState(room, selfId) {
    const previous = this.previous;
    this.previous = room;
    if (!previous || previous.code !== room.code) {
      this.previousTick = null;
      return;
    }
    const self = room.players.find((player) => player.id === selfId);
    const oldSelf = previous.players.find((player) => player.id === selfId);
    if (previous.started && !room.started) {
      const result = room.games[0]?.results.find(
        (player) => player.memberId === (self?.memberId || oldSelf?.memberId),
      );
      this.play(result?.winner ? 'victory' : 'finish');
      this.previousTick = null;
      return;
    }
    if (!room.started) return;
    if (self?.eliminated && !oldSelf?.eliminated) {
      this.play('eliminated');
      return;
    }
    const mine = room.turn === selfId && !self?.spectator && !self?.eliminated;
    if (!previous.started) {
      this.play(mine ? 'turn' : 'start');
      return;
    }
    const newTurn = room.turnId !== previous.turnId;
    if (room.history.length > previous.history.length) {
      const ownWord = Boolean(self?.memberId && room.history.at(-1)?.memberId === self.memberId);
      this.play(mine && newTurn && !ownWord ? 'turn' : 'accepted');
    } else if (mine && newTurn) this.play('turn');
  }
  tick(room, selfId, remaining, connected) {
    const seconds = Math.ceil(remaining / 1000);
    const previous = this.previousTick;
    this.previousTick = { turnId: room.turnId, seconds };
    const self = room.players.find((player) => player.id === selfId);
    if (
      !connected ||
      !room.started ||
      room.paused ||
      room.turn !== selfId ||
      self?.spectator ||
      self?.eliminated ||
      remaining <= 0
    )
      return;
    if (
      previous?.turnId === room.turnId &&
      previous.seconds > seconds &&
      [5, 3, 1].includes(seconds)
    )
      this.play('tick');
  }
}
if (typeof module !== 'undefined') module.exports = { GameSounds, GameSoundEvents };
