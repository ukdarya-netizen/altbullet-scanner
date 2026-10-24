#!/usr/bin/env bash
# Check that committed generated files match what orval would produce from the
# current OpenAPI spec.  Codegen is run into /tmp so this script never touches
# lib/api-client-react/src/generated or lib/api-zod/src/generated while
# typecheck may be reading those paths in parallel.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)

TMPBASE="${TMPDIR:-/tmp}/orval-drift-check"

cleanup() {
  rm -rf "$TMPBASE"
}
trap cleanup EXIT

# Run codegen into $TMPBASE (never touches the real src/generated dirs)
cd "$ROOT/lib/api-spec"
pnpm exec orval --config ./orval.drift.config.ts
node "$ROOT/scripts/normalize-generated-eof.mjs" \
  "$TMPBASE/api-client-react/src/generated" \
  "$TMPBASE/api-zod/src/generated"

# Compare temp output vs committed generated files
drift=0

compare_dir() {
  local tmp_dir="$1"
  local real_dir="$2"
  local label="$3"

  if ! diff -rq "$tmp_dir" "$real_dir" > /dev/null 2>&1; then
    echo "Drift detected in $label:"
    diff -ru "$tmp_dir" "$real_dir" || true
    drift=1
  fi
}

compare_dir \
  "$TMPBASE/api-client-react/src/generated" \
  "$ROOT/lib/api-client-react/src/generated" \
  "lib/api-client-react/src/generated"

compare_dir \
  "$TMPBASE/api-zod/src/generated" \
  "$ROOT/lib/api-zod/src/generated" \
  "lib/api-zod/src/generated"

if [ $drift -ne 0 ]; then
  echo ""
  echo "Drift detected: generated files are out of sync with the OpenAPI spec."
  echo "Run 'pnpm --filter @workspace/api-spec run codegen' and commit the updated generated files."
  exit 1
fi

echo "No drift detected: generated files are in sync with the OpenAPI spec."
