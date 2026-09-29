PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 100000 CHECK(password_iterations = 100000),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_rate (
  ip_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(ip_hash, window_start)
);

CREATE TABLE IF NOT EXISTS voices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 0 CHECK(available IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)),
  description TEXT NOT NULL DEFAULT '',
  reference_key TEXT,
  reference_text TEXT,
  reference_seconds REAL,
  CHECK(available = 0 OR (reference_key IS NOT NULL AND reference_text IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  voice_id TEXT NOT NULL REFERENCES voices(id),
  text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 300),
  request_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0, 1)),
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  worker_id TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  uploaded_audio_key TEXT,
  audio_key TEXT,
  duration_seconds REAL,
  error TEXT,
  phase TEXT,
  completed_segments INTEGER NOT NULL DEFAULT 0,
  total_segments INTEGER NOT NULL DEFAULT 0,
  elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  reclaimed_at INTEGER,
  UNIQUE(user_id, request_key)
);
CREATE INDEX IF NOT EXISTS jobs_user_history ON jobs(user_id, deleted_at, id DESC);
CREATE INDEX IF NOT EXISTS jobs_fifo ON jobs(status, id);
-- Defense in depth: even competing claims cannot create two running jobs.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running ON jobs((1)) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS worker_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  worker_id TEXT NOT NULL,
  last_heartbeat INTEGER NOT NULL,
  ready INTEGER NOT NULL CHECK(ready IN (0, 1)),
  message TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  max_text_length INTEGER NOT NULL DEFAULT 300 CHECK(max_text_length BETWEEN 1 AND 300),
  max_pending_jobs INTEGER NOT NULL DEFAULT 3 CHECK(max_pending_jobs BETWEEN 1 AND 10),
  accepting_jobs INTEGER NOT NULL DEFAULT 1 CHECK(accepting_jobs IN (0,1))
);
INSERT OR IGNORE INTO site_settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL REFERENCES users(id),
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Reservations include completed and interrupted uploads until safe retention cleanup.
CREATE TABLE IF NOT EXISTS audio_uploads (
  version_id TEXT PRIMARY KEY,
  object_key TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 26214400),
  sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL CHECK(chunk_count BETWEEN 1 AND 200),
  content_type TEXT NOT NULL,
  custom_metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audio_chunks (
  version_id TEXT NOT NULL REFERENCES audio_uploads(version_id),
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 199),
  data BLOB NOT NULL CHECK(typeof(data)='blob' AND length(data) BETWEEN 1 AND 131072),
  PRIMARY KEY(version_id, chunk_index)
);
CREATE TABLE IF NOT EXISTS audio_objects (
  object_key TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES audio_uploads(version_id),
  published_at INTEGER NOT NULL
);
