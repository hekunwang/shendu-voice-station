-- Additive migration: existing accounts, jobs and audio remain intact.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin'));
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
ALTER TABLE voices ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1));
CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  max_text_length INTEGER NOT NULL DEFAULT 300 CHECK(max_text_length BETWEEN 1 AND 300),
  accepting_jobs INTEGER NOT NULL DEFAULT 1 CHECK(accepting_jobs IN (0,1))
);
INSERT INTO site_settings(id) VALUES(1);
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
