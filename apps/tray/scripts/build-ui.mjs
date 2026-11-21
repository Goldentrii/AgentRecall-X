import { build } from "esbuild";
import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
await build({ entryPoints: ["src/main.ts"], bundle: true, outfile: "dist/main.js", target: "es2022", minify: false, sourcemap: false });
copyFileSync("src/index.html", "dist/index.html");
copyFileSync("src/style.css", "dist/style.css");
console.log("ui built -> dist/");
