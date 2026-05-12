CREATE TABLE IF NOT EXISTS iocs (
  type     TEXT NOT NULL,
  value    TEXT NOT NULL,
  source   TEXT NOT NULL,
  score    SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (type, value),
  CHECK (type IN ('ip', 'domain', 'sha256'))
);

CREATE INDEX IF NOT EXISTS iocs_added_at_idx ON iocs (added_at DESC);
