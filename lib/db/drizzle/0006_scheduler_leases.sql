CREATE TABLE IF NOT EXISTS "scheduler_leases" (
  "lease_name" text PRIMARY KEY NOT NULL,
  "owner_token" text NOT NULL,
  "acquired_at" timestamp with time zone NOT NULL DEFAULT now(),
  "heartbeat_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);

ALTER TABLE "scheduler_leases"
  ADD COLUMN IF NOT EXISTS "acquired_at" timestamp with time zone NOT NULL DEFAULT now();

ALTER TABLE "scheduler_leases"
  ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone NOT NULL DEFAULT now();