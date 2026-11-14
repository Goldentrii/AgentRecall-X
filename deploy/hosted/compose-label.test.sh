#!/usr/bin/env bash
# The Caddyfile is a single-file bind mount, so compose alone never restarts Caddy
# when it changes. compose.yaml therefore labels caddy with AR_CADDYFILE_SHA (the
# file's sha256, exported by setup.sh and domain-switch.sh before 'docker compose up').
# This proves: the label carries the real hash, a changed Caddyfile changes it (so
# compose recreates caddy), an unchanged one does not, and both scripts compute it
# with the same command. Uses 'docker compose config' only (nothing is started).
#   bash deploy/hosted/compose-label.test.sh   (AR_TEST_REQUIRE_DOCKER=1 fails where Docker is missing; CI sets it)
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then echo "SKIP: docker compose is not available"; exit "${AR_TEST_REQUIRE_DOCKER:-0}"; fi
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); printf 'FAIL %s\n  %s\n' "$1" "${2:-}"; }

# The hashing command is taken from setup.sh itself, then run in a scratch dir.
cmd="$(grep -m1 '^AR_CADDYFILE_SHA=' "$here/setup.sh")"
[[ -n "$cmd" ]] || { echo "FAIL: setup.sh does not set AR_CADDYFILE_SHA"; exit 1; }
# label DIR -> the ar.caddyfile-sha label compose renders for caddy
label() {
  ( cd "$1" && eval "$cmd" && AR_DOMAIN=test.example.com docker compose config 2>&1 | grep -m1 'ar.caddyfile-sha' | sed 's/.*: *//; s/"//g; s/\r//' )
}
mk() { mkdir -p "$work/$1"; cp "$here/compose.yaml" "$here/Caddyfile" "$work/$1/"; }

mk a; real="$(sha256sum "$here/Caddyfile" | cut -d' ' -f1)"
got="$(label "$work/a")"
[[ "$got" == "$real" ]] && ok || bad "label is the Caddyfile's sha256" "got '$got', want '$real'"

[[ "$(label "$work/a")" == "$got" ]] && ok || bad "unchanged Caddyfile keeps the label"

mk b; printf '\n# changed\n' >> "$work/b/Caddyfile"
changed="$(label "$work/b")"
[[ -n "$changed" && "$changed" != "$got" ]] && ok || bad "changed Caddyfile changes the label" "'$changed' vs '$got'"

# unset (someone ran plain 'docker compose up'): a visible placeholder, not a failure
unset_out="$(cd "$work/a" && env -u AR_CADDYFILE_SHA AR_DOMAIN=test.example.com docker compose config 2>&1 | grep -m1 'ar.caddyfile-sha')"
[[ "$unset_out" == *unset* ]] && ok || bad "label falls back to 'unset'" "$unset_out"

# setup.sh and domain-switch.sh compute and export the identical value, before compose up
for f in setup.sh domain-switch.sh; do
  [[ "$(grep -m1 '^AR_CADDYFILE_SHA=' "$here/$f")" == "$cmd" ]] && ok || bad "$f computes the same hash as setup.sh"
  n_up="$(grep -c -E '^(sudo )?(env [^ ]+ )?docker compose up' "$here/$f")"
  first_up="$(grep -n -m1 -E '^(sudo )?(env [^ ]+ )?docker compose up' "$here/$f" | cut -d: -f1)"
  first_exp="$(grep -n -m1 '^AR_CADDYFILE_SHA=.*export AR_CADDYFILE_SHA' "$here/$f" | cut -d: -f1)"
  if [[ "$n_up" -ge 1 && -n "$first_exp" && "$first_exp" -lt "$first_up" ]]; then ok; else bad "$f exports before 'docker compose up'" "export line '$first_exp', first up line '$first_up'"; fi
done
grep -q 'env AR_CADDYFILE_SHA="\$AR_CADDYFILE_SHA" docker compose up' "$here/setup.sh" && ok || bad "setup.sh passes the value through sudo"

printf '%s passed, %s failed\n' "$pass" "$fail"; (( fail == 0 ))
