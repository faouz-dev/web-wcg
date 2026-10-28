const fs = require('node:fs');
const path = require('node:path');
const ROOM_TTL = 7 * 24 * 60 * 60 * 1000;
class RoomStore {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let data = { version: 1, rooms: [] };
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error(`Impossible de lire ${file}. Le fichier est conservé : ${error.message}`);
    }
    if (data.version !== 1 || !Array.isArray(data.rooms))
      throw new Error('Format de la base de rooms invalide.');
    this.rooms = new Map(data.rooms.map((room) => [room.code, room]));
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(
      temp,
      JSON.stringify({ version: 1, rooms: [...this.rooms.values()] }, null, 2),
      { mode: 0o600 },
    );
    fs.renameSync(temp, this.file);
  }
  prune(onlineCodes = new Set()) {
    let changed = false;
    for (const [code, room] of this.rooms) {
      if (!onlineCodes.has(code) && this.now() - room.lastPresenceAt >= ROOM_TTL) {
        this.rooms.delete(code);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
module.exports = { RoomStore, ROOM_TTL };
