/**
 * site-theme.ts — the design tokens of the site's dark look (the home film, film.css),
 * as one CSS custom-property block. Server-rendered pages that are not the film (sign-in,
 * consent, owner review) put this at the top of their one <style> so they read the same
 * palette instead of each carrying its own copy of the colours.
 *
 * Plain constant: no user data, no `</style`, safe to inline under a style hash or
 * 'unsafe-inline'. Text pairs are WCAG AA or better on --card (body text and the
 * warning, error and ok boxes are above 7:1).
 */
export const SITE_TOKENS = `:root{color-scheme:dark;` +
  `--bg:#04060a;--sunk:#070b12;--card:#0c121c;--line:#1e2a3b;` +
  `--ink:#eef1f6;--muted:#c9d3df;--dim:#9aaec3;` +
  `--gold:#F5C451;--cyan:#6fe3ff;` +
  `--warn-bg:#2a1f08;--warn-line:#7a5a14;--warn-ink:#ffd98a;` +
  `--err-bg:#2c1317;--err-line:#7a2a34;--err-ink:#ffb9c0;` +
  `--ok-bg:#0e2a1b;--ok-line:#1f6b43;--ok-ink:#a9e6c0;` +
  `--serif:Georgia,"Times New Roman",serif;` +
  `--sans:"Segoe UI",system-ui,-apple-system,Roboto,sans-serif;` +
  `--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}`;
