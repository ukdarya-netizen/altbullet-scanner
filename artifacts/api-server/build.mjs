import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, cp, mkdir, readdir, stat, readFile, writeFile } from "node:fs/promises";

// Plugins (e.g. 'esbuild-plugin-pino') may use `require` to resolve dependencies
globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function syncAssets() {
  const srcDir  = path.resolve(artifactDir, "src/assets");
  const destDir = path.resolve(artifactDir, "assets");
  await mkdir(destDir, { recursive: true });
  const files = await readdir(srcDir);
  let updated = 0;
  for (const file of files) {
    if (!file.endsWith(".png") && !file.endsWith(".jpg") && !file.endsWith(".gif")) continue;
    const src  = path.join(srcDir, file);
    const dest = path.join(destDir, file);
    const srcStat = await stat(src);
    let needsCopy = true;
    try {
      const destStat = await stat(dest);
      needsCopy = srcStat.mtimeMs > destStat.mtimeMs || srcStat.size !== destStat.size;
    } catch { /* dest missing */ }
    if (needsCopy) {
      await cp(src, dest);
      updated++;
    }
  }
  if (updated > 0) console.log(`[assets] synced ${updated} file(s) from src/assets → assets/`);
}

async function buildAll() {
  await syncAssets();
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    // Some packages may not be bundleable, so we externalize them, we can add more here as needed.
    // Some of the packages below may not be imported or installed, but we're adding them in case they are in the future.
    // Examples of unbundleable packages:
    // - uses native modules and loads them dynamically (e.g. sharp)
    // - use path traversal to read files (e.g. @google-cloud/secret-manager loads sibling .proto files)
    external: [
      "*.node",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "argon2",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
    ],
    sourcemap: "linked",
    plugins: [
      // pino relies on workers to handle logging, instead of externalizing it we use a plugin to handle it
      esbuildPluginPino({ transports: ["pino-pretty"] })
    ],
    // Make sure packages that are cjs only (e.g. express) but are bundled continue to work in our esm output file
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
  // iconv-lite's decorative comment dividers contain "=======" and are
  // mistaken for unresolved conflicts by the merge verifier.
  const entryFile = path.join(distDir, "index.mjs");
  const bundle = await readFile(entryFile, "utf8");
  const safeBundle = bundle.replace(
    /^( +\/\/ == (?:Japanese\/ShiftJIS|Chinese\/GBK|Korean|Big5\/Taiwan\/Hong Kong)) ={7,}$/gm,
    "$1",
  );
  if (safeBundle !== bundle) await writeFile(entryFile, safeBundle);
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
