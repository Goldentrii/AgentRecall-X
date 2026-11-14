/**
 * mock-providers.mjs — in-process MOCK GitHub and Google OAuth endpoints (node:http)
 * for the hosted-server tests. Never talks to the real providers.
 *
 * `issue()` plays the provider's browser step (the user signs in and consents) and
 * returns the code the provider would put on the redirect back to our callback.
 * Shared by hosted-oauth.test.mjs and hosted-review.test.mjs.
 */
import * as http from "node:http";
import { createHash, randomBytes } from "node:crypto";

export const b64url = (buf) => buf.toString("base64url");
export const sha256b64 = (s) => b64url(createHash("sha256").update(s).digest());

export const GH = { id: "gh-client-id", secret: "gh-client-secret" };
export const GG = { id: "gg-client-id.apps.example", secret: "gg-client-secret" };
export const jwt = (claims) => `${b64url(Buffer.from('{"alg":"RS256"}'))}.${b64url(Buffer.from(JSON.stringify(claims)))}.sig`;

/** Mock GitHub + Google endpoints. Set `state.base` to the server's public URL (redirect_uri is checked against it). */
export async function startMock({ port = 0 } = {}) {
  const state = { codes: new Map(), calls: [], ghUserMode: "ok", ggTokenMode: "ok", base: "" };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const body = Object.fromEntries(new URLSearchParams(raw));
      state.calls.push({ method: req.method, path: req.url, body, headers: req.headers });
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const rec = state.codes.get(body.code);
      const verify = (prov, creds) => rec && rec.provider === prov && body.client_id === creds.id && body.client_secret === creds.secret
        && body.redirect_uri === `${state.base}/authorize/callback/${prov}` && sha256b64(body.code_verifier ?? "") === rec.challenge;
      if (req.method === "POST" && req.url === "/gh/token") {
        if (state.ghTokenMode === "hang") return; // never answers: the server's provider timeout must fire
        if (!verify("github", GH)) return send(200, { error: "bad_verification_code" });
        state.codes.delete(body.code);
        state.tokens = { ...(state.tokens ?? {}), [`gho_${body.code}`]: rec };
        return send(200, { access_token: `gho_${body.code}`, token_type: "bearer", scope: "" });
      }
      if (req.method === "GET" && req.url === "/gh/user") {
        const prof = state.tokens?.[String(req.headers.authorization ?? "").replace("Bearer ", "")];
        if (!prof || !/agent-recall-server/.test(String(req.headers["user-agent"]))) return send(401, { message: "Bad credentials" });
        if (state.ghUserMode === "500") return send(500, { message: "boom at /srv/secret.go:12" });
        if (state.ghUserMode === "nonnumeric") return send(200, { id: "12abc" });
        return send(200, { id: prof.profile.id, login: "someone" });
      }
      if (req.method === "POST" && req.url === "/gg/token") {
        if (state.ggTokenMode === "down") return void req.socket.destroy();
        if (!verify("google", GG)) return send(400, { error: "invalid_grant" });
        state.codes.delete(body.code);
        const claims = { iss: "https://accounts.google.com", aud: GG.id, sub: rec.profile.sub, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, nonce: rec.nonce, ...rec.claims };
        return send(200, { access_token: "ya29.x", id_token: jwt(claims), token_type: "Bearer" });
      }
      send(404, { error: "nope" });
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    state, url,
    issue(provider, { profile, challenge, nonce, claims }) {
      const code = "up-" + b64url(randomBytes(12));
      state.codes.set(code, { provider, profile, challenge, nonce, claims });
      return code;
    },
    urls: { githubAuthorize: `${url}/gh/authorize`, githubToken: `${url}/gh/token`, githubApi: `${url}/gh/user`, googleAuthorize: `${url}/gg/authorize`, googleToken: `${url}/gg/token` },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
