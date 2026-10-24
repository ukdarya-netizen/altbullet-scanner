/**
 * Orval config used ONLY by scripts/check-codegen-drift.sh.
 * Outputs generated files to /tmp so the drift check never touches
 * lib/api-client-react/src/generated or lib/api-zod/src/generated while
 * typecheck may be reading those paths in parallel.
 *
 * The custom-fetch mutator is copied into the same relative position inside
 * the temp tree so orval produces the same "../custom-fetch" import that the
 * real config produces (orval computes the import as a relative path from the
 * generated file's directory to the mutator file's absolute path).
 */
import { defineConfig, InputTransformerFn } from "orval";
import path from "path";
import os from "os";
import fs from "fs";

const root = path.resolve(__dirname, "..", "..");
const apiClientReactSrc = path.resolve(root, "lib", "api-client-react", "src");

// Stable temp base: /tmp/orval-drift-check
const tmpBase = path.join(os.tmpdir(), "orval-drift-check");
const tmpApiClientSrc = path.join(tmpBase, "api-client-react", "src");
const tmpApiZodSrc = path.join(tmpBase, "api-zod", "src");

// Ensure temp dirs exist
fs.mkdirSync(tmpApiClientSrc, { recursive: true });
fs.mkdirSync(tmpApiZodSrc, { recursive: true });

// Copy custom-fetch.ts into the temp tree so orval resolves the relative
// import as "../custom-fetch" (same as in the real output).
const tmpMutatorPath = path.join(tmpApiClientSrc, "custom-fetch.ts");
fs.copyFileSync(
  path.join(apiClientReactSrc, "custom-fetch.ts"),
  tmpMutatorPath,
);

const titleTransformer: InputTransformerFn = (config) => {
  config.info ??= {};
  config.info.title = "Api";
  return config;
};

export default defineConfig({
  "api-client-react": {
    input: {
      target: "./openapi.yaml",
      override: { transformer: titleTransformer },
    },
    output: {
      target: path.join(tmpApiClientSrc, "generated"),
      client: "react-query",
      mode: "split",
      baseUrl: "/api",
      clean: true,
      prettier: true,
      override: {
        fetch: { includeHttpResponseReturnType: false },
        // Use the TEMP copy of custom-fetch so orval computes
        // the relative import as "../custom-fetch" — same as real output.
        mutator: {
          path: tmpMutatorPath,
          name: "customFetch",
        },
      },
    },
  },
  zod: {
    input: {
      target: "./openapi.yaml",
      override: { transformer: titleTransformer },
    },
    output: {
      client: "zod",
      target: path.join(tmpApiZodSrc, "generated"),
      schemas: {
        path: path.join(tmpApiZodSrc, "generated", "types"),
        type: "typescript",
      },
      mode: "split",
      clean: true,
      prettier: true,
      override: {
        zod: {
          version: 3,
          coerce: {
            query: ["boolean", "number", "string"],
            param: ["boolean", "number", "string"],
            body: ["bigint", "date"],
            response: ["bigint", "date"],
          },
        },
        useDates: true,
        useBigInt: true,
      },
    },
  },
});
