#!/usr/bin/env bash
# Move hosted AgentRecall to a new primary domain and keep old ones working.
#
#   sudo bash /opt/agent-recall/deploy/hosted/domain-switch.sh <primary> [alias ...]
#   e.g.  sudo bash domain-switch.sh agentrecallx.com recall.aiakada.com www.agentrecallx.com
#
# <primary> becomes AR_DOMAIN (and AR_PUBLIC_URL when sign-in is on). Each alias
# (at most 4) keeps answering /mcp and /healthz, so agents configured with the old
# address and a static token keep working; every other path on an alias redirects
# to the primary. Run it again with other arguments to change or drop aliases.
#
# Before running:
#   - every name's DNS A record must point at this box (checked; AR_FORCE=1 skips);
#   - if sign-in is on, change the OAuth app's callback URL to the new domain at the
#     same time (GitHub allows one callback per app). The script prints the exact URL.
# Effects to expect: everyone who signed in with GitHub/Google signs in once more
# (their grants are bound to the old address); static tokens are untouched.
# Rollback: the previous settings are kept in .env.before-domain-switch (mode 600).
set -euo pipefail

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || die "run with sudo:  sudo bash $0 <primary> [alias ...]"

cd "$(dirname "$(readlink -f "$0")")"
[[ -f compose.yaml && -f .env ]] || die "run setup.sh first (no deploy/hosted/.env here)"

(( $# >= 1 )) || die "usage: sudo bash $0 <primary-domain> [alias-domain ...]"
DOMAIN_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
for name in "$@"; do
  # One regex match on the whole argument: a newline, comma, scheme or space fails it.
  [[ "$name" =~ $DOMAIN_RE && ${#name} -le 253 ]] || die "'${name//[^[:print:]]/?}' is not a valid lowercase domain name"
done
primary="$1"; shift
aliases=("$@")
(( ${#aliases[@]} <= 4 )) || die "at most 4 aliases (got ${#aliases[@]})"
seen=" "
for a in "${aliases[@]}"; do
  [[ "$a" != "$primary" ]] || die "$a is given as both the primary and an alias"
  [[ "$seen" != *" $a "* ]] || die "alias $a is listed twice"
  seen+="$a "
done

old="$(grep -m1 '^AR_DOMAIN=' .env | cut -d= -f2- || true)"
oauth_on=0
grep -q '^AR_PUBLIC_URL=.' .env && oauth_on=1

echo "==> DNS check"
box_ip="$(curl -fsS -4 --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"
dns_ok=1
for name in "$primary" "${aliases[@]}"; do
  ip="$(getent ahostsv4 "$name" | awk 'NR==1 {print $1}' || true)"
  ip6="$(getent ahosts "$name" | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ {print $1; exit}' || true)"
  if [[ -z "$box_ip" || "$ip" != "$box_ip" ]]; then
    echo "A record: $name -> '${ip:-nothing}', but this box is '${box_ip:-unknown}'."
    dns_ok=0
  elif [[ -n "$ip6" ]]; then
    echo "AAAA record: $name -> $ip6. Let's Encrypt may validate over IPv6; remove the AAAA record unless it is this box."
    dns_ok=0
  else
    echo "$name -> $ip (this box)"
  fi
done
if (( ! dns_ok )); then
  if [[ "${AR_FORCE:-0}" == "1" ]]; then
    echo "WARNING: continuing anyway (AR_FORCE=1); HTTPS works once DNS is right."
  else
    die "fix DNS first (or wait for it to propagate), then re-run. Nothing was changed. AR_FORCE=1 skips this check."
  fi
fi

echo
echo "==> About to switch"
echo "  primary:  ${old:-none}  ->  $primary"
if (( ${#aliases[@]} )); then
  echo "  aliases:  ${aliases[*]}   (/mcp and /healthz keep working; other paths redirect to $primary)"
else
  echo "  aliases:  none"
fi
if (( oauth_on )); then
  echo "  sign-in:  on. Everyone who signed in with GitHub or Google must sign in again."
  echo "            Change the OAuth app callback URL now, before you confirm:"
  grep -q '^AR_OAUTH_GITHUB_CLIENT_ID=.' .env && echo "              GitHub:  https://$primary/authorize/callback/github"
  grep -q '^AR_OAUTH_GOOGLE_CLIENT_ID=.' .env && echo "              Google:  https://$primary/authorize/callback/google"
fi
echo "  static tokens keep working on the primary and on every alias."
echo
confirm=""
read -rp "Type the new primary domain to confirm: " confirm || true
[[ "$confirm" == "$primary" ]] || die "confirmation did not match; nothing was changed"

tmp="$(mktemp ./.env.XXXXXX)"   # same directory (so mv is an atomic rename), mode 600, removed on exit
trap 'rm -f "$tmp"' EXIT
grep -v -E '^(AR_DOMAIN|AR_DOMAIN_ALIAS|AR_PUBLIC_URL)=' .env > "$tmp" || true
# Never glue the new lines onto a last line that lacks its newline.
if [[ -s "$tmp" && -n "$(tail -c1 "$tmp")" ]]; then echo >> "$tmp"; fi
printf 'AR_DOMAIN=%s\n' "$primary" >> "$tmp"
if (( ${#aliases[@]} )); then
  list="$(printf '%s, ' "${aliases[@]}")"
  printf 'AR_DOMAIN_ALIAS=%s\n' "${list%, }" >> "$tmp"
fi
if (( oauth_on )); then printf 'AR_PUBLIC_URL=https://%s\n' "$primary" >> "$tmp"; fi
chmod 600 "$tmp"
cp -p .env .env.before-domain-switch
chmod 600 .env.before-domain-switch
mv -f "$tmp" .env
echo "saved to $(pwd)/.env (previous settings: .env.before-domain-switch)"

rollback() {
  cat <<EOF

To go back to the previous settings:
  cd $(pwd) && sudo cp -p .env.before-domain-switch .env && sudo docker compose up -d
(and restore the old OAuth callback URL if you changed it)
EOF
}

echo "==> restarting (Caddy requests a certificate for each new name)"
docker compose up -d || { rollback; die "the settings were saved, but the restart failed; see: sudo docker compose logs --tail 40 caddy server"; }

wait_health() { # HOST TRIES
  local i
  for i in $(seq 1 "$2"); do
    if health="$(curl -fsS --max-time 5 "https://$1/healthz" 2>/dev/null)"; then
      echo "https://$1/healthz -> $health"
      return 0
    fi
    sleep 5
  done
  return 1
}

echo "==> health (waits up to 5 min per name for its HTTPS certificate)"
failed=0
wait_health "$primary" 60 || { echo "https://$primary/healthz did not answer within 5 minutes."; failed=1; }
for a in "${aliases[@]}"; do
  if ! wait_health "$a" 60; then echo "https://$a/healthz did not answer within 5 minutes."; failed=1; continue; fi
  to="$(curl -sS -o /dev/null --max-time 10 -w '%{redirect_url}' "https://$a/connect" 2>/dev/null || true)"
  if [[ "$to" == "https://$primary/"* ]]; then
    echo "https://$a/connect -> $to"
  else
    echo "https://$a/connect does not redirect to https://$primary/ (got '${to:-nothing}')."
    failed=1
  fi
done

if (( failed )); then
  rollback
  die "the switch is saved but not healthy. Check: sudo docker compose ps && sudo docker compose logs --tail 50 caddy server"
fi

echo
echo "Done. Agents connect to:  https://$primary/mcp"
(( oauth_on )) && echo "Sign in again at:         https://$primary/connect"
rollback
