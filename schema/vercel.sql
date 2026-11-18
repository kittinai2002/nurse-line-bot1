-- One Neon database per LINE OA. Run once in Neon SQL Editor.
CREATE TABLE IF NOT EXISTS nurse_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS nurse_cloud_accounts (
  user_id text PRIMARY KEY CHECK (user_id ~ '^U[a-f0-9]{32}$'),
  snapshot jsonb,
  revision bigint NOT NULL DEFAULT 0,
  lease_owner uuid,
  lease_until timestamptz,
  next_due timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS nurse_cloud_due ON nurse_cloud_accounts(next_due) WHERE next_due IS NOT NULL;
