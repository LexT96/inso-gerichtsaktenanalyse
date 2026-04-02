CREATE TABLE IF NOT EXISTS verwalter_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  titel TEXT DEFAULT '',
  geschlecht TEXT NOT NULL DEFAULT 'maennlich' CHECK(geschlecht IN ('maennlich', 'weiblich')),
  diktatzeichen TEXT DEFAULT '',
  sachbearbeiter_name TEXT DEFAULT '',
  sachbearbeiter_email TEXT DEFAULT '',
  sachbearbeiter_durchwahl TEXT DEFAULT '',
  standort TEXT DEFAULT '',
  anderkonto_iban TEXT DEFAULT '',
  anderkonto_bank TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
