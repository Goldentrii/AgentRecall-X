/**
 * provider-mock-preload.mjs — TEST ONLY. Loaded with `node --import` into a spawned
 * `agent-recall-server` so the REAL binary (default provider URLs, no test seams)
 * can sign users in against mock-providers.mjs.
 *
 * It replaces globalThis.fetch before the server starts: the three provider endpoints
 * the server calls go to AR_TEST_PROVIDER_MOCK (an http://127.0.0.1 mock); any other
 * outbound fetch fails, so a test can never reach the network.
 * The browser leg (the authorize redirect) is played by the test itself.
 */
const mock = process.env.AR_TEST_PROVIDER_MOCK;
if (!mock || !/^http:\/\/127\.0\.0\.1:\d+$/.test(mock)) throw new Error("provider-mock-preload: AR_TEST_PROVIDER_MOCK must be http://127.0.0.1:<port>");

const ROUTES = new Map([
  ["https://github.com/login/oauth/access_token", "/gh/token"],
  ["https://api.github.com/user", "/gh/user"],
  ["https://oauth2.googleapis.com/token", "/gg/token"],
]);
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const route = ROUTES.get(url);
  if (!route) return Promise.reject(new Error(`provider-mock-preload: outbound fetch refused: ${url}`));
  return realFetch(mock + route, init);
};
