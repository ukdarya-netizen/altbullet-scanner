CREATE TABLE IF NOT EXISTS btc_regime_observations (
  id serial PRIMARY KEY,
  bucket_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  price real,
  whale_index real,
  whale_index_candle_at timestamptz,
  whale_index_source text,
  ob_bid_usd real,
  ob_ask_usd real,
  ob_ratio real,
  ob_source text,
  ob_coverage text,
  fetch_status text NOT NULL DEFAULT 'partial',
  forward_1h_pct real,
  forward_4h_pct real,
  forward_24h_pct real,
  forward_1h_status text NOT NULL DEFAULT 'pending',
  forward_4h_status text NOT NULL DEFAULT 'pending',
  forward_24h_status text NOT NULL DEFAULT 'pending',
  forward_1h_resolved_at timestamptz,
  forward_4h_resolved_at timestamptz,
  forward_24h_resolved_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS btc_regime_bucket_uniq ON btc_regime_observations (bucket_at);
CREATE INDEX IF NOT EXISTS btc_regime_bucket_desc_idx ON btc_regime_observations (bucket_at DESC);