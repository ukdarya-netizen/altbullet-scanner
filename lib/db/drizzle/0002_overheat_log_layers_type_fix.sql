ALTER TABLE "overheat_log" ALTER COLUMN "layers" SET DATA TYPE text[] USING ARRAY[]::text[];
