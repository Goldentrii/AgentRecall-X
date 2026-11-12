#!/usr/bin/env bash
# agent-recall-remote — the ONLY thing an agent's deploy key can run on the server.
#
# Installed once as /usr/local/bin/agent-recall-remote and bound to one SSH key in
# ~/.ssh/authorized_keys with:
#   restrict,command="/usr/local/bin/agent-recall-remote" ssh-ed25519 AAAA… agent-recall-deploy
# `restrict` turns off shells, port/agent/X11 forwarding and PTYs; `command=` makes sshd
# run this script whatever the client asks, passing the request in SSH_ORIGINAL_COMMAND.
#
# Allowed requests (anything else is refused):
#   deploy <40-hex commit>   build + restart at that commit; it MUST already be on main
#   status                   containers, deployed commit, /healthz
#   logs [N]                 last N (default 50, max 500) server log lines
#   usage                    storage per user
#
# AR_REMOTE_DRY_RUN=1 (tests only; sshd never passes client env through) prints the
# action instead of running it. Removing the key's line from authorized_keys revokes it.
set -euo pipefail
export LC_ALL=C   # a client may send LC_* (sshd AcceptEnv); keep regex ranges byte-exact

REPO_SLUG="Goldentrii/AgentRecall-X"
# Deploy only the newest commits of main: no rollback to an old, possibly vulnerable version.
MAX_BEHIND_MAIN=30
APP_DIR="${AR_REMOTE_APP_DIR:-/opt/agent-recall}"
HOSTED_DIR="$APP_DIR/deploy/hosted"
DRY="${AR_REMOTE_DRY_RUN:-0}"

deny() { printf 'refused: %s\n' "$1" >&2; exit 64; }
run() { if [[ "$DRY" == "1" ]]; then printf 'DRY-RUN: %s\n' "$*"; else "$@"; fi; }

req="${SSH_ORIGINAL_COMMAND:-}"
# Plain words only: no shell syntax can reach a command line, whatever the client sends.
[[ "$req" =~ ^[a-z]+(\ [0-9a-f]{1,40})?$ ]] || deny "allowed: deploy <commit> | status | logs [N] | usage"
verb="${req%% *}"
arg=""
[[ "$req" == *" "* ]] && arg="${req#* }"

domain() {
  local d
  d="$(sudo grep -m1 '^AR_DOMAIN=' "$HOSTED_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
  [[ "$d" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || deny "AR_DOMAIN missing in $HOSTED_DIR/.env (run setup.sh once by hand first)"
  printf '%s' "$d"
}

# True when <sha> is main itself or one of its last MAX_BEHIND_MAIN ancestors (GitHub compare
# API, no token needed: compare/<sha>...main is "ahead" when main is ahead of sha). Fails closed.
on_main() {
  local sha="$1" body
  body="$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO_SLUG/compare/$sha...main")" || return 1
  python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
ok = d.get("status") in ("identical", "ahead") and isinstance(d.get("ahead_by"), int) and d["ahead_by"] <= int(sys.argv[1])
sys.exit(0 if ok else 1)' "$MAX_BEHIND_MAIN" <<<"$body"
}

case "$verb" in
  deploy)
    [[ "$arg" =~ ^[0-9a-f]{40}$ ]] || deny "deploy needs the full 40-character commit sha"
    if [[ "$DRY" != "1" ]]; then
      on_main "$arg" || deny "commit $arg is not among the last $MAX_BEHIND_MAIN commits of main (merge it first), or GitHub could not be reached"
    fi
    d="$(domain)"
    # One deploy at a time: a second one is refused instead of racing the first on a 1 GB box.
    exec 9>"${AR_REMOTE_LOCK:-/tmp/agent-recall-deploy.lock}"
    flock -n 9 || deny "another deploy is running; try again when it has finished"
    script="$(mktemp)"
    trap 'rm -f "$script"' EXIT
    run curl -fsSL "https://raw.githubusercontent.com/$REPO_SLUG/$arg/deploy/hosted/setup.sh" -o "$script"
    run env AR_DOMAIN="$d" AR_REF="$arg" bash "$script"
    ;;
  status)
    [[ -z "$arg" ]] || deny "status takes no argument"
    d="$(domain)"
    printf 'deployed commit: %s\n' "$(sudo git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    run sudo docker compose --project-directory "$HOSTED_DIR" ps --format 'table {{.Name}}\t{{.Status}}'
    printf 'healthz: '; run curl -fsS --max-time 10 "https://$d/healthz"; echo
    ;;
  logs)
    n="${arg:-50}"
    [[ "$n" =~ ^[0-9]{1,3}$ ]] && (( n >= 1 && n <= 500 )) || deny "logs N must be 1-500"
    run sudo docker compose --project-directory "$HOSTED_DIR" logs --no-color --tail "$n" server
    ;;
  usage)
    [[ -z "$arg" ]] || deny "usage takes no argument"
    run sudo docker compose --project-directory "$HOSTED_DIR" exec -T server agent-recall-server usage
    ;;
  *)
    deny "unknown request '$verb'"
    ;;
esac
