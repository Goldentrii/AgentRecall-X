#!/usr/bin/env bash
# Turn on "Sign in with GitHub" for hosted AgentRecall: store a GitHub OAuth app's
# client id + secret in deploy/hosted/.env (mode 600) WITHOUT echoing the secret,
# restart the stack, and check that OAuth discovery answers.
#
#   sudo bash /opt/agent-recall/deploy/hosted/oauth-setup.sh
#
# Create the OAuth app first (GitHub > Settings > Developer settings > OAuth Apps):
#   Homepage URL:               https://<AR_DOMAIN>
#   Authorization callback URL: https://<AR_DOMAIN>/authorize/callback/github
# Re-run to replace the credentials. Sign-up stays invite-only (AR_OAUTH_SIGNUP):
# invite accounts with `agent-recall-server identity link --github-id <id> [--uid <uid>]`.
set -euo pipefail

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo:  sudo bash $0"

cd "$(dirname "$(readlink -f "$0")")"
[[ -f compose.yaml && -f .env ]] || die "run setup.sh first (no deploy/hosted/.env here)"

domain="$(grep -m1 '^AR_DOMAIN=' .env | cut -d= -f2- || true)"
[[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "AR_DOMAIN in .env is missing or invalid"

# Browser terminals may wrap a paste in bracketed-paste markers (ESC[200~ … ESC[201~); strip
# those, control characters and whitespace so they never end up inside a credential.
clean() { printf '%s' "$1" | sed $'s/\x1b\\[20[01]~//g' | tr -d '[:space:][:cntrl:]'; }

printf 'GitHub OAuth app for https://%s\n' "$domain"
printf '  callback URL must be: https://%s/authorize/callback/github\n\n' "$domain"
read -rp "Client ID: " raw_id
id="$(clean "$raw_id")"
[[ "$id" =~ ^[A-Za-z0-9._-]{10,64}$ ]] || die "that does not look like a GitHub OAuth Client ID; nothing was saved"
read -rsp "Client secret (input hidden): " raw_secret
echo
secret="$(clean "$raw_secret")"
unset raw_secret
[[ "$secret" =~ ^[0-9a-f]{40}$ ]] || die "that does not look like a GitHub client secret (40 hex characters); nothing was saved"

tmp="$(mktemp ./.env.XXXXXX)"   # same directory (so mv is an atomic rename), mode 600, removed on exit
trap 'rm -f "$tmp"' EXIT
grep -v -E '^(AR_PUBLIC_URL|AR_OAUTH_GITHUB_CLIENT_ID|AR_OAUTH_GITHUB_CLIENT_SECRET)=' .env > "$tmp" || true
# Never glue the new lines onto a last line that lacks its newline.
if [[ -s "$tmp" && -n "$(tail -c1 "$tmp")" ]]; then echo >> "$tmp"; fi
printf 'AR_PUBLIC_URL=https://%s\nAR_OAUTH_GITHUB_CLIENT_ID=%s\nAR_OAUTH_GITHUB_CLIENT_SECRET=%s\n' "$domain" "$id" "$secret" >> "$tmp"
unset secret
chmod 600 "$tmp"
mv -f "$tmp" .env
echo "saved to $(pwd)/.env (mode 600)"

echo "restarting the server with OAuth on…"
AR_CADDYFILE_SHA="$(sha256sum Caddyfile | cut -d' ' -f1)"; export AR_CADDYFILE_SHA  # compose.yaml label: recreates Caddy when the Caddyfile changed
docker compose up -d || die "credentials were saved, but the restart failed; see: cd $(pwd) && sudo docker compose logs --tail 40 server"
for _ in $(seq 1 60); do
  if issuer="$(curl -fsS --max-time 5 "https://$domain/.well-known/oauth-authorization-server" 2>/dev/null | grep -o '"issuer":"[^"]*"')"; then
    echo "OAuth is on: $issuer"
    echo
    echo "Next: invite your GitHub account onto an existing tenant (or omit --uid for its own):"
    echo "  cd $(pwd) && sudo docker compose exec server agent-recall-server identity link --github-id <your GitHub id> --uid <uid>"
    exit 0
  fi
  sleep 2
done
echo "OAuth discovery did not answer within 2 minutes. Check:  cd $(pwd) && sudo docker compose logs --tail 40 server"
exit 1
