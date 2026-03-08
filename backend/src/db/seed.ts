import bcrypt from 'bcrypt';
import { initDatabase, getDb, closeDatabase } from './database';

async function seed(): Promise<void> {
  const dbPath = process.env.DATABASE_PATH || './data/insolvenz.db';
  const username = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const password = process.env.DEFAULT_ADMIN_PASSWORD;

  if (!password) {
    console.error('DEFAULT_ADMIN_PASSWORD muss gesetzt sein.');
    process.exit(1);
  }

  initDatabase(dbPath);
  const db = getDb();

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    console.log(`Admin-Benutzer "${username}" existiert bereits.`);
    closeDatabase();
    return;
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare(
    'INSERT INTO users (username, password_hash, display_name, role) VALUES (?, ?, ?, ?)'
  ).run(username, hash, 'Administrator', 'admin');

  console.log(`Admin-Benutzer "${username}" erstellt.`);
  closeDatabase();
}

seed().catch(err => {
  console.error('Seed fehlgeschlagen:', err);
  process.exit(1);
});
