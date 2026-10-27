import { build } from "esbuild";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url)),
  out = root + "dist";
fs.mkdirSync(out, { recursive: true });
await build({
  entryPoints: [root + "src/main.jsx"],
  outfile: out + "/app.js",
  bundle: true,
  format: "esm",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  target: ["chrome120", "safari17"],
  logLevel: "warning",
});
fs.writeFileSync(
  out + "/index.html",
  '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>鱼 · 本地观察室</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>',
);
console.error("Observer UI built");
