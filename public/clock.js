class GameClock {
  constructor(monotonicNow = () => performance.now()) { this.now = monotonicNow; this.anchor = null; this.bestRtt = Infinity; }
  sync(serverTime, sentAt, receivedAt = this.now()) {
    const rtt = Math.max(0, receivedAt - sentAt);
    if (!Number.isFinite(serverTime) || rtt > this.bestRtt + 25) return;
    this.bestRtt = Math.min(this.bestRtt, rtt);
    this.anchor = { local: receivedAt, server: serverTime + rtt / 2 };
  }
  observe(serverTime) { if (!this.anchor && Number.isFinite(serverTime)) this.anchor = { local: this.now(), server: serverTime }; }
  serverNow() { return this.anchor ? this.anchor.server + this.now() - this.anchor.local : null; }
  remaining(deadlineAt) { const time = this.serverNow(); return deadlineAt === null || time === null ? 0 : Math.max(0, deadlineAt - time); }
}
if (typeof module !== 'undefined') module.exports = { GameClock };
