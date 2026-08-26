CREATE TABLE IF NOT EXISTS qq_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  app_id TEXT NOT NULL DEFAULT '',
  client_secret TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO qq_config (id) VALUES (1);
