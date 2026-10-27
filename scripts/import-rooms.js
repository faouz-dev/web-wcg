const { readFileSync } = require('node:fs');
const { PostgresStore } = require('../lib/postgres-store');
async function main() {
  try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!process.env.DATABASE_URL || !process.argv[2]) throw new Error('Usage : npm run import:rooms -- chemin/rooms.json ; DATABASE_URL doit être configuré.');
  const data = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^\uFEFF/, ''));
  if (data.version !== 1 || !Array.isArray(data.rooms)) throw new Error('Format JSON invalide.');
  for (const room of data.rooms) if (!/^[A-Z0-9]{6}$/.test(room.code) || !room.members || !Array.isArray(room.games) || !Number.isFinite(room.lastPresenceAt)) throw new Error('Une room est invalide.');
  const store = await PostgresStore.open({ connectionString: process.env.DATABASE_URL });
  try {
    let added = 0;
    for (const room of data.rooms) if (!store.rooms.has(room.code)) { store.rooms.set(room.code, room); added++; }
    await store.save(); console.log(`${added} rooms importées. Les codes déjà présents n’ont pas été écrasés.`);
  } finally { await store.close(); }
}
main().catch(error => { console.error(error.code ? 'Import impossible : vérifie le fichier et la connexion PostgreSQL.' : error.message); process.exitCode = 1; });
