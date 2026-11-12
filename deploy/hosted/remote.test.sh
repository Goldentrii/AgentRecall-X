#!/usr/bin/env bash
# Tests for remote.sh (the deploy key's forced command): what it accepts and what it refuses.
# Uses a fake app dir and stubbed sudo/git/docker/curl, so it needs no server.
#   bash deploy/hosted/remote.test.sh
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/app/deploy/hosted" "$work/bin"
echo "AR_DOMAIN=recall.example.com" > "$work/app/deploy/hosted/.env"
# Stubs: sudo runs the rest as is; git/docker print what they were asked.
printf '#!/usr/bin/env bash\n"$@"\n' > "$work/bin/sudo"
printf '#!/usr/bin/env bash\necho "stub-git $*"\n' > "$work/bin/git"
printf '#!/usr/bin/env bash\necho "stub-docker $*"\n' > "$work/bin/docker"
# curl: the GitHub compare API answers with $AR_TEST_COMPARE (or fails when AR_TEST_API_DOWN is set);
# any other URL is echoed and nothing is downloaded (so the deployed "setup.sh" is empty).
cat > "$work/bin/curl" <<'STUB'
#!/usr/bin/env bash
if [[ "$*" == *api.github.com* ]]; then
  [[ -n "${AR_TEST_API_DOWN:-}" ]] && exit 22
  printf '%s' "${AR_TEST_COMPARE:-}"
  exit 0
fi
echo "stub-curl $*"
STUB
chmod +x "$work/bin/"*

pass=0; fail=0
# check NAME REQUEST EXPECTED_EXIT OUTPUT_REGEX [VAR=VALUE ...]   (DRY=0 in the extra vars = real mode)
check() {
  local name="$1" req="$2" want="$3" re="$4"; shift 4
  local out code
  out="$(env PATH="$work/bin:$PATH" HOME="$work" AR_REMOTE_APP_DIR="$work/app" \
        AR_REMOTE_LOCK="$work/deploy.lock" AR_REMOTE_DRY_RUN=1 "$@" \
        SSH_ORIGINAL_COMMAND="$req" bash "$here/remote.sh" 2>&1)"; code=$?
  if [[ $code -eq $want && "$out" =~ $re ]]; then pass=$((pass+1)); else fail=$((fail+1)); printf 'FAIL %s\n  request=%q exit=%s\n  %s\n' "$name" "$req" "$code" "$out"; fi
}
SHA=4ab7ef51bae607f9ba8576e6699cdfee3612d373
J() { printf '{"status":"%s","ahead_by":%s,"files":[{"status":"added"}]}' "$1" "$2"; }

# accepted (dry run)
check "deploy full sha"        "deploy $SHA"      0  "DRY-RUN: env AR_DOMAIN=recall.example.com AR_REF=$SHA bash /"
check "deploy fetches pinned"  "deploy $SHA"      0  "raw.githubusercontent.com/Goldentrii/AgentRecall-X/$SHA/deploy/hosted/setup.sh"
check "status"                 "status"           0  "DRY-RUN: sudo docker compose .* ps"
check "logs default"           "logs"             0  "--tail 50 server"
check "logs N"                 "logs 200"         0  "--tail 200 server"
check "usage"                  "usage"            0  "exec -T server agent-recall-server usage"

# refused: shell syntax, interactive login, other commands, bad args
check "no command (shell)"     ""                 64 "refused"
check "shell injection ;"      "status; rm -rf /" 64 "refused"
check "shell injection \$()"   'deploy $(id)'     64 "refused"
check "backticks"              'logs `id`'        64 "refused"
check "pipe"                   "logs 5 | sh"      64 "refused"
check "newline"                $'status\nid'      64 "refused"
check "other command"          "bash"             64 "refused"
check "scp attempt"            "scp -t /tmp"      64 "refused"
check "unknown verb"           "reboot"           64 "refused"
check "short sha"              "deploy 4ab7ef5"   64 "full 40-character"
check "uppercase sha"          "deploy ${SHA^^}"  64 "refused"
check "branch name"            "deploy main"      64 "refused"
check "logs too many"          "logs 999"         64 "1-500"
check "logs zero"              "logs 0"           64 "1-500"
check "status with arg"        "status 1"         64 "no argument"
check "usage with arg"         "usage 1"          64 "no argument"
check "two args"               "logs 5 6"         64 "refused"

# the on-main check (real mode, stubbed GitHub): only the newest commits of main deploy
check "main itself deploys"      "deploy $SHA" 0  "stub-curl .*/$SHA/deploy/hosted/setup.sh" AR_REMOTE_DRY_RUN=0 "AR_TEST_COMPARE=$(J identical 0)"
check "30 behind main deploys"   "deploy $SHA" 0  "stub-curl"                                AR_REMOTE_DRY_RUN=0 "AR_TEST_COMPARE=$(J ahead 30)"
check "31 behind main refused"   "deploy $SHA" 64 "last 30 commits of main"                  AR_REMOTE_DRY_RUN=0 "AR_TEST_COMPARE=$(J ahead 31)"
check "fork/PR commit refused"   "deploy $SHA" 64 "last 30 commits of main"                  AR_REMOTE_DRY_RUN=0 "AR_TEST_COMPARE=$(J diverged 2)"
check "newer-than-main refused"  "deploy $SHA" 64 "last 30 commits of main"                  AR_REMOTE_DRY_RUN=0 "AR_TEST_COMPARE=$(J behind 0)"
check "garbage answer refused"   "deploy $SHA" 64 "last 30 commits of main"                  AR_REMOTE_DRY_RUN=0 "AR_TEST_COMPARE=not-json"
check "GitHub down fails closed" "deploy $SHA" 64 "could not be reached"                     AR_REMOTE_DRY_RUN=0 AR_TEST_API_DOWN=1

# one deploy at a time
( flock 9; sleep 3 ) 9>"$work/deploy.lock" &
sleep 1
check "concurrent deploy refused" "deploy $SHA" 64 "another deploy is running"
wait

# a missing/invalid AR_DOMAIN is refused, not passed on
echo "AR_DOMAIN=bad domain;rm" > "$work/app/deploy/hosted/.env"
check "bad AR_DOMAIN"          "deploy $SHA"      64 "AR_DOMAIN missing"

printf '%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
