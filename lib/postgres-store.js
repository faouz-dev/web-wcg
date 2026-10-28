const { Pool } = require('pg');
const { ROOM_TTL } = require('./room-store');
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS wcg_rooms (code text PRIMARY KEY, data jsonb NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS wcg_events (id text PRIMARY KEY, type text NOT NULL, at bigint NOT NULL, visitor_id text, name text, country text, room_code text, payload jsonb NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS wcg_events_at_idx ON wcg_events(at)`,
  `CREATE INDEX IF NOT EXISTS wcg_events_type_at_idx ON wcg_events(type, at)`,
];
class PostgresStore {
  constructor(pool, now = Date.now) {
    this.pool = pool;
    this.now = now;
    this.rooms = new Map();
    this.persisted = new Map();
    this.pending = Promise.resolve();
    this.lastError = null;
    this.kind = 'postgres';
  }
  static async open({ connectionString, pool, now = Date.now }) {
    const store = new PostgresStore(
      pool ||
        new Pool({
          connectionString,
          max: 4,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 20000,
          query_timeout: 10000,
        }),
      now,
    );
    store.pool.on('error', () => {
      store.lastError = 'Connexion PostgreSQL interrompue.';
    });
    try {
      for (const query of SCHEMA) await store.pool.query(query);
      const { rows } = await store.pool.query('SELECT code, data FROM wcg_rooms');
      for (const { code, data } of rows) {
        store.rooms.set(code, data);
        store.persisted.set(code, JSON.stringify(data));
      }
      return store;
    } catch (error) {
      await store.pool.end();
      throw new Error(
        'Initialisation PostgreSQL impossible. Vérifie DATABASE_URL, le réseau et les droits de création des tables.',
        { cause: error },
      );
    }
  }
  enqueue(task) {
    this.pending = this.pending
      .catch(() => {})
      .then(task)
      .then(
        (result) => {
          this.lastError = null;
          return result;
        },
        () => {
          this.lastError = 'Sauvegarde PostgreSQL indisponible.';
          const error = new Error(this.lastError);
          error.code = 'DB_SAVE_FAILED';
          throw error;
        },
      );
    this.pending.catch(() => {});
    return this.pending;
  }
  save() {
    const snapshot = new Map([...this.rooms].map(([code, data]) => [code, JSON.stringify(data)]));
    return this.enqueue(async () => {
      const changed = [...snapshot].filter(([code, json]) => this.persisted.get(code) !== json);
      const removed = [...this.persisted.keys()].filter((code) => !snapshot.has(code));
      if (!changed.length && !removed.length) return;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const [code, json] of changed)
          await client.query(
            'INSERT INTO wcg_rooms (code, data) VALUES ($1, $2::jsonb) ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data',
            [code, json],
          );
        for (const code of removed)
          await client.query('DELETE FROM wcg_rooms WHERE code = $1', [code]);
        await client.query('COMMIT');
        this.persisted = snapshot;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
  }
  flush() {
    return this.pending;
  }
  prune(onlineCodes = new Set()) {
    let changed = false;
    for (const [code, room] of this.rooms)
      if (!onlineCodes.has(code) && this.now() - room.lastPresenceAt >= ROOM_TTL) {
        this.rooms.delete(code);
        changed = true;
      }
    if (changed) this.save();
  }
  async close() {
    try {
      await this.flush();
    } finally {
      await this.pool.end();
    }
  }
}
module.exports = { PostgresStore, SCHEMA };
