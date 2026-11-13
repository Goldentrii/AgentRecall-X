#!/usr/bin/env bash
# Tests for domain-switch.sh: what it writes to .env, what it refuses, and that a
# refusal leaves .env untouched. Uses a fake hosted dir and stubbed
# id/getent/curl/docker/sleep, so it needs no server and no root.
#   bash deploy/hosted/domain-switch.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# Stubs. id: root unless AR_TEST_NOT_ROOT. getent: every name resolves to
# $AR_TEST_DNS_IP (default: the box), except names listed in $AR_TEST_DNS_WRONG;
# `ahosts` adds an IPv6 line for names in $AR_TEST_DNS_V6. curl: checkip answers the
# box IP; healthz answers ok unless the host is in $AR_TEST_DOWN; a page request on
# an alias answers the redirect target. docker and sleep only log.
cat > "$work/bin/id" <<'STUB'
#!/usr/bin/env bash
if [[ -n "${AR_TEST_NOT_ROOT:-}" ]]; then echo 1000; else echo 0; fi
STUB
cat > "$work/bin/getent" <<'STUB'
#!/usr/bin/env bash
kind="$1"; name="$2"
ip="${AR_TEST_DNS_IP:-203.0.113.7}"
[[ " ${AR_TEST_DNS_WRONG:-} " == *" $name "* ]] && ip="198.51.100.9"
echo "$ip STREAM $name"
if [[ "$kind" == "ahosts" && " ${AR_TEST_DNS_V6:-} " == *" $name "* ]]; then echo "2001:db8::1 STREAM $name"; fi
STUB
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
url="${!#}"
if [[ "$url" == *checkip* ]]; then echo "203.0.113.7"; exit 0; fi
host="${url#https://}"; host="${host%%/*}"
[[ " ${AR_TEST_DOWN:-} " == *" $host "* ]] && exit 7
if [[ "$url" == */healthz ]]; then echo '{"ok":true,"version":"test"}'; exit 0; fi
if [[ "$*" == *redirect_url* ]]; then echo "${AR_TEST_REDIRECT:-https://new.example.com/connect}"; exit 0; fi
exit 0
STUB
printf '#!/usr/bin/env bash\necho "stub-docker $*" >> "%s/docker.log"\n' "$work" > "$work/bin/docker"
printf '#!/usr/bin/env bash\nexit 0\n' > "$work/bin/sleep"
chmod +x "$work/bin/"*

pass=0; fail=0
ok()  { pass=$((pass+1)); }
bad() { fail=$((fail+1)); printf 'FAIL %s\n%s\n' "$1" "${2:-}"; }

# fresh ENV_BODY: a new hosted dir holding the script, a compose file and .env
fresh() {
  dir="$work/hosted.$RANDOM$RANDOM"; mkdir -p "$dir"
  cp "$here/domain-switch.sh" "$dir/"; : > "$dir/compose.yaml"
  printf '%s' "$1" > "$dir/.env"; chmod 600 "$dir/.env"
  : > "$work/docker.log"
}
# run ANSWER ARGS... [-- VAR=VALUE ...]  -> sets $out and $code
run() {
  local answer="$1"; shift
  local args=() envs=()
  while (( $# )); do if [[ "$1" == "--" ]]; then shift; envs=("$@"); break; fi; args+=("$1"); shift; done
  out="$(printf '%s\n' "$answer" | env PATH="$work/bin:$PATH" "${envs[@]}" bash "$dir/domain-switch.sh" "${args[@]}" 2>&1)"; code=$?
}
has()   { grep -qxF -- "$1" "$dir/.env"; }
lacks() { ! grep -q -- "$1" "$dir/.env"; }

OAUTH=$'AR_DOMAIN=old.example.com\nAR_PUBLIC_URL=https://old.example.com\nAR_OAUTH_GITHUB_CLIENT_ID=Iv1.abcdef123456\nAR_OAUTH_GITHUB_CLIENT_SECRET=0123456789abcdef0123456789abcdef01234567\nAR_OAUTH_SIGNUP=open\n'
PLAIN=$'AR_DOMAIN=old.example.com\n'

# 1. the normal switch: new primary, old domain + www kept as aliases, OAuth on
fresh "$OAUTH"
run "new.example.com" new.example.com old.example.com www.new.example.com
if [[ $code -eq 0 ]] && has "AR_DOMAIN=new.example.com" && has "AR_PUBLIC_URL=https://new.example.com" \
   && has "AR_DOMAIN_ALIAS=old.example.com, www.new.example.com" \
   && has "AR_OAUTH_GITHUB_CLIENT_SECRET=0123456789abcdef0123456789abcdef01234567" && has "AR_OAUTH_SIGNUP=open" \
   && [[ "$(grep -c '^AR_DOMAIN=' "$dir/.env")" == 1 && "$(grep -c '^AR_PUBLIC_URL=' "$dir/.env")" == 1 ]]; then ok; else bad "switch with aliases" "$out"; fi
# File modes mean nothing on a filesystem that ignores chmod (Git Bash on Windows): check them only where they do.
probe="$work/mode-probe"; : > "$probe"; chmod 600 "$probe"
if [[ "$(stat -c %a "$probe")" == 600 ]]; then modes=1; else modes=0; echo "note: this filesystem ignores chmod; mode checks skipped"; fi
if (( modes )); then [[ "$(stat -c %a "$dir/.env")" == 600 ]] && ok || bad ".env stays mode 600" "$(stat -c %a "$dir/.env")"; fi
grep -qxF "AR_DOMAIN=old.example.com" "$dir/.env.before-domain-switch" 2>/dev/null && ok || bad "backup holds the old .env"
if (( modes )); then [[ "$(stat -c %a "$dir/.env.before-domain-switch" 2>/dev/null)" == 600 ]] && ok || bad "backup is mode 600"; fi
grep -q "stub-docker compose up -d" "$work/docker.log" && ok || bad "stack restarted" "$(cat "$work/docker.log")"
[[ "$out" == *"https://new.example.com/authorize/callback/github"* ]] && ok || bad "prints the GitHub callback to register" "$out"
[[ "$out" == *"sign in again"* ]] && ok || bad "warns that sign-ins are reset" "$out"
[[ "$out" != *"0123456789abcdef0123456789abcdef01234567"* ]] && ok || bad "never prints the client secret" "$out"
[[ "$out" == *".env.before-domain-switch"* ]] && ok || bad "prints how to roll back" "$out"

# 2. OAuth off: AR_PUBLIC_URL is not invented
fresh "$PLAIN"
run "new.example.com" new.example.com old.example.com
if [[ $code -eq 0 ]] && has "AR_DOMAIN=new.example.com" && has "AR_DOMAIN_ALIAS=old.example.com" && lacks "AR_PUBLIC_URL"; then ok; else bad "no AR_PUBLIC_URL when OAuth is off" "$out"; fi
[[ "$out" != *"authorize/callback"* ]] && ok || bad "no callback hint when OAuth is off" "$out"

# 3. no aliases: an earlier alias line is removed, not kept
fresh $'AR_DOMAIN=old.example.com\nAR_DOMAIN_ALIAS=ancient.example.com\n'
run "new.example.com" new.example.com
if [[ $code -eq 0 ]] && has "AR_DOMAIN=new.example.com" && lacks "AR_DOMAIN_ALIAS"; then ok; else bad "alias line dropped when none given" "$out"; fi

# 4. a last line without a newline is not glued to the new lines
fresh "AR_DOMAIN=old.example.com
AR_OAUTH_SIGNUP=open"
run "new.example.com" new.example.com
if [[ $code -eq 0 ]] && has "AR_OAUTH_SIGNUP=open" && has "AR_DOMAIN=new.example.com"; then ok; else bad "missing trailing newline handled" "$(cat "$dir/.env")"; fi

# refusals: each must exit non-zero AND leave .env byte-identical, with no restart
refuse() { # NAME REGEX ANSWER ARGS... [-- VAR=VALUE ...]
  local name="$1" re="$2"; shift 2
  fresh "$OAUTH"; local before; before="$(cat "$dir/.env")"
  run "$@"
  if [[ $code -ne 0 && "$out" =~ $re && "$(cat "$dir/.env")" == "$before" && ! -s "$work/docker.log" && ! -e "$dir/.env.before-domain-switch" ]]; then ok
  else bad "refuse: $name (exit $code)" "$out"; fi
}
refuse "not root"                 "sudo"                  "new.example.com" new.example.com -- AR_TEST_NOT_ROOT=1
refuse "no arguments"             "usage"                 "x"
refuse "uppercase domain"         "not a valid"           "x" New.Example.com
refuse "domain with scheme"       "not a valid"           "x" https://new.example.com
refuse "shell metacharacters"     "not a valid"           "x" 'new.example.com;id'
refuse "newline in a domain"      "not a valid"           "x" $'new.example.com\nAR_OAUTH_SIGNUP=open'
refuse "alias with a comma"       "not a valid"           "x" new.example.com 'a.example.com,b.example.com'
refuse "alias equals primary"     "both the primary"      "x" new.example.com new.example.com
refuse "duplicate alias"          "listed twice"          "x" new.example.com old.example.com old.example.com
refuse "too many aliases"         "at most 4"             "x" new.example.com a.example.com b.example.com c.example.com d.example.com e.example.com
refuse "primary DNS elsewhere"    "fix DNS"               "x" new.example.com old.example.com -- "AR_TEST_DNS_WRONG=new.example.com"
refuse "alias DNS elsewhere"      "fix DNS"               "x" new.example.com old.example.com -- "AR_TEST_DNS_WRONG=old.example.com"
refuse "stray AAAA record"        "AAAA"                  "x" new.example.com -- "AR_TEST_DNS_V6=new.example.com"
refuse "wrong confirmation"       "nothing was changed"   "yes" new.example.com old.example.com
refuse "empty confirmation"       "nothing was changed"   "" new.example.com old.example.com

# AR_FORCE=1 skips the DNS check only
fresh "$OAUTH"
run "new.example.com" new.example.com -- "AR_TEST_DNS_WRONG=new.example.com" AR_FORCE=1
[[ $code -eq 0 ]] && has "AR_DOMAIN=new.example.com" && ok || bad "AR_FORCE=1 skips DNS" "$out"

# the new domain never comes up: exit non-zero, .env switched, rollback printed
fresh "$OAUTH"
run "new.example.com" new.example.com old.example.com -- "AR_TEST_DOWN=new.example.com"
if [[ $code -ne 0 && "$out" == *"cp -p .env.before-domain-switch .env"* ]] && has "AR_DOMAIN=new.example.com"; then ok; else bad "health failure prints the rollback" "$out"; fi

# an alias that does not redirect pages to the primary is reported
fresh "$OAUTH"
run "new.example.com" new.example.com old.example.com -- "AR_TEST_REDIRECT=https://elsewhere.example.net/"
[[ $code -ne 0 && "$out" == *"does not redirect"* ]] && ok || bad "alias redirect is verified" "$out"

printf '%s passed, %s failed\n' "$pass" "$fail"
(( fail == 0 ))
