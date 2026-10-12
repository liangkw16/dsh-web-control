CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  device_verifier TEXT NOT NULL,
  link_verifier TEXT NOT NULL,
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 1 AND auth_epoch <= 9007199254740991),
  enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1))
);
CREATE TABLE browser_sessions (
  token_verifier TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES devices(id),
  auth_epoch INTEGER NOT NULL CHECK(auth_epoch >= 1 AND auth_epoch <= 9007199254740991),
  expires_at INTEGER NOT NULL CHECK(expires_at >= 0 AND expires_at <= 9007199254740991)
);
CREATE INDEX browser_sessions_instance ON browser_sessions(instance_id);
