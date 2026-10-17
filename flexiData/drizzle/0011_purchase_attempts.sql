-- Additive only: no backfill, no mutation of legacy ledger/account balances.
CREATE TABLE purchase_attempts (
  ref varchar(40) PRIMARY KEY REFERENCES transactions(ref),
  wallet_id integer NOT NULL REFERENCES wallets(id),
  request_key varchar(100) NOT NULL,
  fingerprint varchar(64) NOT NULL,
  request jsonb NOT NULL,
  float_reserved boolean NOT NULL DEFAULT false,
  source varchar(10) NOT NULL CONSTRAINT purchase_attempt_source CHECK (source IN ('wallet','checkout')),
  provider varchar(40) NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'created'
    CONSTRAINT purchase_attempt_state CHECK (state IN ('created','submitted','pending','unknown','delivered','failed')),
  provider_reference varchar(120),
  poll_count integer NOT NULL DEFAULT 0 CONSTRAINT purchase_attempt_poll_count CHECK (poll_count BETWEEN 0 AND 12),
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX purchase_attempt_wallet_key ON purchase_attempts(wallet_id,request_key);
CREATE UNIQUE INDEX purchase_attempt_provider_reference ON purchase_attempts(provider,provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX purchase_attempt_due ON purchase_attempts(next_poll_at)
  WHERE state IN ('submitted','pending','unknown');
