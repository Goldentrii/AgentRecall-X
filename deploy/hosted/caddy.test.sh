#!/usr/bin/env bash
# Behaviour test for the Caddyfile with the real pinned Caddy image and a stub
# upstream: the primary proxies everything; an alias proxies /mcp and /healthz
# (keeping the Authorization header) and redirects every other path to the
# primary; with no alias set, another host name is not served.
# Needs Docker and curl. Uses *.localhost names, for which Caddy issues its own local
# certificates, so nothing leaves the machine.
#   bash deploy/hosted/caddy.test.sh      (AR_TEST_REQUIRE_DOCKER=1 fails where Docker is missing; CI sets it)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then echo "SKIP: Docker is not running"; exit "${AR_TEST_REQUIRE_DOCKER:-0}"; fi
IMG="$(grep -m1 -E '^\s*image: caddy:' "$here/compose.yaml" | awk '{print $2}')"
[[ "$IMG" == caddy:*@sha256:* ]] || { echo "FAIL: could not read the pinned caddy image from compose.yaml"; exit 1; }
net="ar-caddy-test-$$"; up="ar-caddy-up-$$"; cad="ar-caddy-$$"
cfg="$here/Caddyfile"; if command -v cygpath >/dev/null; then cfg="$(cygpath -w "$cfg")"; fi
export MSYS_NO_PATHCONV=1
cleanup() { docker rm -f "$cad" "$up" >/dev/null 2>&1; docker network rm "$net" >/dev/null 2>&1; }
trap cleanup EXIT
docker network create "$net" >/dev/null || exit 1
# Stub upstream named "server" on :8787: echoes the path and the Authorization header.
docker run -d --name "$up" --network "$net" --network-alias server "$IMG" \
  caddy respond --listen :8787 --body "upstream path={http.request.uri} auth={http.request.header.Authorization}" >/dev/null || exit 1

pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); printf 'FAIL %s\n  %s\n' "$1" "${2:-}"; }
finish() { printf '%s passed, %s failed\n' "$pass" "$fail"; (( fail == 0 )); exit $?; }

start() { # PRIMARY ALIAS_VALUE
  docker rm -f "$cad" >/dev/null 2>&1
  # 443 is published on a random loopback port; requests go there with --resolve.
  docker run -d --name "$cad" --network "$net" -p 127.0.0.1::443 -p 127.0.0.1::80 -e AR_DOMAIN="$1" -e AR_DOMAIN_ALIAS="$2"     -v "$cfg:/etc/caddy/Caddyfile:ro" "$IMG" >/dev/null || return 1
  port="$(docker port "$cad" 443/tcp | head -1 | sed 's/.*://')"
  port80="$(docker port "$cad" 80/tcp | head -1 | sed 's/.*://')"
  local i
  for i in $(seq 1 60); do
    if curl -fsSk --max-time 3 --resolve "$1:$port:127.0.0.1" "https://$1:$port/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  docker logs --tail 20 "$cad" 2>&1
  return 1
}
# get HOST PATH -> "<status> <location> | <body>"; the port is stripped from Location
get() {
  local body code loc
  body="$(curl -sk --max-time 5 --resolve "$1:$port:127.0.0.1" -H "Authorization: Bearer ar_test"     -o - -w '
%{http_code} %{redirect_url}' "https://$1:$port$2" 2>&1)"
  code="${body##*$'
'}"; body="${body%$'
'*}"
  loc="${code#* }"; code="${code%% *}"
  printf '%s %s | %s
' "$code" "$loc" "$body"
}
# plain HOST PATH -> "<status> <location>" over plain HTTP (port 80)
plain() { curl -s --max-time 5 --resolve "$1:$port80:127.0.0.1" -o /dev/null -w '%{http_code} %{redirect_url}' "http://$1:$port80$2" 2>&1; }
expect() { # NAME HOST PATH GLOB
  local r; r="$(get "$2" "$3")"
  # shellcheck disable=SC2053
  if [[ "$r" == $4 ]]; then ok; else bad "$1" "$r"; fi
}

start primary.localhost "old.localhost, www.primary.localhost" || { bad "caddy starts with two aliases"; finish; }
expect "primary proxies pages"                 primary.localhost     /connect  "200 *path=/connect*"
expect "primary proxies /mcp"                  primary.localhost     /mcp      "200 *path=/mcp auth=Bearer ar_test*"
expect "alias proxies /mcp with Authorization" old.localhost         /mcp      "200 *path=/mcp auth=Bearer ar_test*"
expect "alias proxies /healthz"                old.localhost         /healthz  "200 *path=/healthz*"
expect "second alias proxies /mcp"             www.primary.localhost /mcp      "200 *path=/mcp*"
expect "alias redirects pages, path and query" old.localhost         "/connect?x=1" "308 https://primary.localhost/connect?x=1 *"
expect "alias redirects the home page"         old.localhost         /         "308 https://primary.localhost/ *"
expect "alias redirects OAuth discovery"       old.localhost         /.well-known/oauth-authorization-server "308 https://primary.localhost/.well-known/oauth-authorization-server *"
expect "alias redirects the sign-in callback"  old.localhost         /authorize/callback/github "308 *"
expect "alias does not proxy a look-alike path" old.localhost        /mcpx     "308 *"

r="$(plain old.localhost '/mcp?a=1')"
if [[ "$r" == "308 https://old.localhost/mcp?a=1" ]]; then ok; else bad "plain HTTP on an alias upgrades to HTTPS on the same name" "$r"; fi

# No alias set: the placeholder compose passes. Caddy must start, serve the
# primary, not serve another name, and not ask for a certificate for the placeholder.
start primary.localhost "http://alias-unset.invalid" || { bad "caddy starts with the placeholder"; finish; }
expect "primary works with no alias"           primary.localhost     /mcp      "200 *path=/mcp*"
r="$(get old.localhost /mcp)"
if [[ "$r" != "200 "* ]]; then ok; else bad "an unset alias name is not served" "$r"; fi
r="$(plain primary.localhost /connect)"
if [[ "$r" == "308 https://primary.localhost/connect" ]]; then ok; else bad "plain HTTP on the primary still upgrades with the placeholder set" "$r"; fi
n="$(docker logs "$cad" 2>&1 | grep -c "alias-unset.invalid" || true)"
if [[ "$n" == 0 ]]; then ok; else bad "nothing is attempted for the placeholder name" "$n log lines mention it"; fi

finish
