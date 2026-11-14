// Build step: tsc only emits .js, so copy the home page film's assets (css, script,
// plates) from src/http/film to dist/http/film, where film.ts reads them at start.
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../src/http/film", import.meta.url));
const to = fileURLToPath(new URL("../dist/http/film", import.meta.url));
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith(".gitattributes") });
