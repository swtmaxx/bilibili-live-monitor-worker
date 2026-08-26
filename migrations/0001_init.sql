PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('uid', 'room')),
  source_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  room_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  live_status INTEGER CHECK (live_status IN (0, 1) OR live_status IS NULL),
  last_title TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_monitors_scan
  ON monitors (enabled, id);

CREATE INDEX IF NOT EXISTS idx_monitors_uid
  ON monitors (uid);

CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('private', 'group')),
  target_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (type, target_id)
);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  interval_minutes INTEGER NOT NULL DEFAULT 1 CHECK (interval_minutes BETWEEN 1 AND 60),
  notify_start INTEGER NOT NULL DEFAULT 1 CHECK (notify_start IN (0, 1)),
  notify_end INTEGER NOT NULL DEFAULT 1 CHECK (notify_end IN (0, 1)),
  format TEXT NOT NULL DEFAULT 'text' CHECK (format IN ('text', 'markdown')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS monitor_transitions (
  transition_key TEXT PRIMARY KEY,
  monitor_id INTEGER NOT NULL,
  previous_status INTEGER,
  current_status INTEGER NOT NULL CHECK (current_status IN (0, 1)),
  title TEXT NOT NULL DEFAULT '',
  room_id TEXT,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (monitor_id) REFERENCES monitors (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transitions_monitor
  ON monitor_transitions (monitor_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transition_key TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('text', 'markdown')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  FOREIGN KEY (transition_key) REFERENCES monitor_transitions (transition_key) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES targets (id) ON DELETE CASCADE,
  UNIQUE (transition_key, target_id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox (status, next_attempt_at, id);

CREATE TABLE IF NOT EXISTS job_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_check_at TEXT,
  scan_active INTEGER NOT NULL DEFAULT 0 CHECK (scan_active IN (0, 1)),
  scan_cursor INTEGER NOT NULL DEFAULT 0,
  scan_total INTEGER NOT NULL DEFAULT 0,
  scan_processed INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT,
  lock_until TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  last_error TEXT,
  last_checked_count INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO job_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS admin_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions (expires_at);
