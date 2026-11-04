import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(import.meta.url);
const ts = require("/home/runner/workspace/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript");
const cyr = /[А-Яа-яЁё]/;
const out = new Set();
const norm = (s) => s.replace(/\s+/g, " ").trim();
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx?)$/.test(e.name) && !/\.test\./.test(e.name)) scan(p);
  }
}
function add(s) { const n = norm(s); if (n && cyr.test(n)) out.add(n); }
function scan(file) {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  (function visit(n) {
    if (ts.isImportDeclaration(n)) return;
    if (ts.isJsxText(n)) add(n.getText());
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) add(n.text);
    else if (ts.isTemplateExpression(n)) {
      let s = n.head.text;
      n.templateSpans.forEach((sp, i) => { s += "{" + i + "}" + sp.literal.text; });
      add(s);
      n.templateSpans.forEach((sp) => visit(sp.expression));
      return;
    }
    ts.forEachChild(n, visit);
  })(src);
}
walk("src");
fs.writeFileSync("/tmp/i18n-strings.json", JSON.stringify([...out].sort(), null, 1));
console.log(out.size);
