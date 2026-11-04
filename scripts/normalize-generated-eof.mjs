import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

async function normalize(target) {
  const targetStat = await stat(target);
  if (targetStat.isDirectory()) {
    const entries = await readdir(target);
    await Promise.all(entries.map((entry) => normalize(path.join(target, entry))));
    return;
  }
  if (!target.endsWith(".ts")) return;

  const source = await readFile(target, "utf8");
  const normalized = `${source.trimEnd()}\n`;
  if (normalized !== source) {
    await writeFile(target, normalized);
  }
}

await Promise.all(process.argv.slice(2).map((target) => normalize(target)));