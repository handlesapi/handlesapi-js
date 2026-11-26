// Builds ESM (dist/esm) and CommonJS (dist/cjs) with plain tsc, then marks dist/cjs as CommonJS.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = resolve(root, "node_modules/typescript/bin/tsc");
rmSync(resolve(root, "dist"), { recursive: true, force: true });
for (const cfg of ["tsconfig.esm.json", "tsconfig.cjs.json"]) {
  execFileSync(process.execPath, [tsc, "-p", resolve(root, cfg)], { stdio: "inherit", cwd: root });
}
mkdirSync(resolve(root, "dist/cjs"), { recursive: true });
writeFileSync(resolve(root, "dist/cjs/package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
writeFileSync(resolve(root, "dist/esm/package.json"), JSON.stringify({ type: "module" }) + "\n");
console.log("built dist/esm and dist/cjs");
