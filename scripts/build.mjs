import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const stylesCss = await readFile(join(repoRoot, "styles.css"), "utf8");
const entryPath = join(repoRoot, "src/index.ts");

const result = await Bun.build({
  entrypoints: [entryPath],
  target: "browser",
  format: "esm",
  sourcemap: "none",
  minify: false,
  define: {
    __GRAPH_VIEW_STYLES_CSS__: JSON.stringify(stylesCss),
  },
});

if (!result.success) {
  const messages = result.logs.map((log) => log.message || String(log)).join("\n");
  throw new Error(`Failed to bundle main.js:\n${messages}`);
}

const mainArtifact = result.outputs.find((output) => output.path.endsWith(".js")) ?? result.outputs[0];
if (!mainArtifact) {
  throw new Error("Bun.build produced no JavaScript artifact.");
}

const mainJs = await mainArtifact.text();
await writeFile(join(repoRoot, "main.js"), mainJs, "utf8");

console.log(JSON.stringify({
  ok: true,
  mainJsBytes: new TextEncoder().encode(mainJs).byteLength,
  stylesBytes: new TextEncoder().encode(stylesCss).byteLength,
}));
