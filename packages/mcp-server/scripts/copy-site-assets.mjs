// Build step: tsc only emits .js, so copy the home page film's assets (css, script,
// plates) from src/http/film to dist/http/film, where film.ts reads them at start.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const from = fileURLToPath(new URL("../src/http/film", import.meta.url));
const to = fileURLToPath(new URL("../dist/http/film", import.meta.url));
rmSync(to, { recursive: true, force: true });
cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith(".gitattributes") });

// The privacy policy: PRIVACY.md at the repo root is the single source; the site renders the copy shipped in dist.
const policy = fileURLToPath(new URL("../../../PRIVACY.md", import.meta.url));
if (!existsSync(policy)) throw new Error(`PRIVACY.md not found at ${policy}: the site's /privacy page needs it (Docker builds must COPY it)`);
const legalDir = fileURLToPath(new URL("../dist/http/legal", import.meta.url));
rmSync(legalDir, { recursive: true, force: true });
mkdirSync(legalDir, { recursive: true });
copyFileSync(policy, `${legalDir}/PRIVACY.md`);
