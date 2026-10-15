// Minimal application-owned queue for the preemption experiment. Not production.
import { DatabaseSync } from "node:sqlite";

export function openQueue(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS events(
    seq INTEGER PRIMARY KEY, id TEXT UNIQUE, priority INTEGER,
    body TEXT, state TEXT DEFAULT 'pending', attempt INTEGER DEFAULT 0
  )`);
  return {
    admit(id, priority, body) {
      db.prepare("INSERT OR IGNORE INTO events(id,priority,body) VALUES(?,?,?)").run(id, priority, body);
    },
    next() {
      return db.prepare("SELECT * FROM events WHERE state IN ('pending','suspended','running') ORDER BY priority DESC,seq LIMIT 1").get();
    },
    start(id) {
      db.prepare("UPDATE events SET state='running',attempt=attempt+1 WHERE id=?").run(id);
      return db.prepare("SELECT * FROM events WHERE id=?").get(id);
    },
    state(id, state) { db.prepare("UPDATE events SET state=? WHERE id=?").run(state, id); },
    all() { return db.prepare("SELECT * FROM events ORDER BY seq").all(); },
    close() { db.close(); },
  };
}
