const { createHmac, randomBytes } = require('node:crypto');
const ipaddr = require('ipaddr.js');
const DAY = 86400000;
function publicIp(value) {
  try { const address = ipaddr.process(value); return address.range() === 'unicast' ? address.toString() : null; } catch { return null; }
}
class CountryResolver {
  constructor({ enabled = process.env.GEOIP_API_ENABLED !== '0', fetchImpl = fetch, now = Date.now, maxEntries = 2000, dailyLimit = 900, maxConcurrent = 4 } = {}) {
    this.enabled = enabled; this.fetch = fetchImpl; this.now = now; this.maxEntries = maxEntries; this.dailyLimit = dailyLimit; this.maxConcurrent = maxConcurrent;
    this.cache = new Map(); this.inflight = new Map(); this.salt = randomBytes(32); this.day = ''; this.requests = 0; this.blockedUntil = 0;
  }
  remember(key, country, ttl) {
    this.cache.delete(key);
    for (const [id, item] of this.cache) if (item.expiresAt <= this.now()) this.cache.delete(id);
    while (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { country, expiresAt: this.now() + ttl });
    return country;
  }
  async resolve(ip, fallback = 'ZZ') {
    const address = publicIp(ip);
    if (!this.enabled || !address) return fallback;
    const key = createHmac('sha256', this.salt).update(address).digest('hex');
    const cached = this.cache.get(key);
    if (cached?.expiresAt > this.now()) return cached.country;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const day = new Date(this.now()).toISOString().slice(0,10);
    if (day !== this.day) { this.day = day; this.requests = 0; }
    if (this.now() < this.blockedUntil || this.requests >= this.dailyLimit || this.inflight.size >= this.maxConcurrent) return this.remember(key, fallback, 300000);
    this.requests++;
    const task = this.lookup(address, key, fallback).finally(() => this.inflight.delete(key));
    this.inflight.set(key, task); return task;
  }
  async lookup(ip, key, fallback) {
    try {
      const response = await this.fetch('https://ipwho.is/' + encodeURIComponent(ip) + '?fields=success,country_code', { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/json' } });
      if (response.status === 429) {
        const value = response.headers?.get('retry-after');
        const seconds = value && /^\d+$/.test(value) ? Number(value) : value ? (Date.parse(value) - this.now()) / 1000 : 86400;
        this.blockedUntil = this.now() + Math.min(DAY, Math.max(60000, Number.isFinite(seconds) ? seconds*1000 : DAY));
        return this.remember(key, fallback, 300000);
      }
      if (!response.ok) return this.remember(key, fallback, 300000);
      const data = await response.json();
      if (data.success !== true || !/^[A-Z]{2}$/.test(data.country_code || '') || ['ZZ','XX'].includes(data.country_code)) return this.remember(key, fallback, 300000);
      return this.remember(key, data.country_code, DAY);
    } catch { return this.remember(key, fallback, 300000); }
  }
}
module.exports = { CountryResolver, publicIp };
