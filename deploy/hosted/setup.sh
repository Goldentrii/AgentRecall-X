#!/usr/bin/env bash
# Install or update hosted AgentRecall on a fresh Ubuntu 24.04 box (e.g. AWS Lightsail).
#
#   AR_DOMAIN=recall.example.com AR_REF=<commit sha> bash setup.sh
#
# AR_REF: pin a reviewed commit SHA (recommended); a branch name also works but
# then a re-run builds whatever that branch holds at the time.
# Idempotent: re-run with a newer AR_REF to update. Installs only from Ubuntu's
# own package repositories (docker.io, docker-compose-v2, git, curl).
# Point the domain's DNS A record at this box BEFORE running: the script refuses
# to start otherwise (AR_FORCE=1 overrides), so failed certificate requests
# don't burn Let's Encrypt's rate limit.
set -euo pipefail

AR_DOMAIN="${AR_DOMAIN:-}"
AR_REF="${AR_REF:-feat/hosted-mcp-server}"
AR_DIR="${AR_DIR:-/opt/agent-recall}"
AR_FORCE="${AR_FORCE:-0}"
AR_REPO="https://github.com/Goldentrii/AgentRecall-X.git"
APT=(sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -y -qq)

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ -n "$AR_DOMAIN" ]] || die "set AR_DOMAIN, e.g.  AR_DOMAIN=recall.example.com bash setup.sh"
[[ "$AR_DOMAIN" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "AR_DOMAIN '$AR_DOMAIN' is not a valid lowercase domain name"
[[ "$AR_REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "AR_REF '$AR_REF' has unexpected characters"
[[ "$AR_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "AR_DIR must be an absolute path"

say "1/7 preflight"
free_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
(( free_gb >= 6 )) || die "only ${free_gb} GB free on /; need at least 6 GB (image build + swap)"
echo "${free_gb} GB free"

say "2/7 DNS check"
box_ip="$(curl -fsS -4 --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]' || true)"
dns_ip="$(getent ahostsv4 "$AR_DOMAIN" | awk 'NR==1 {print $1}' || true)"
dns_ip6="$(getent ahosts "$AR_DOMAIN" | awk '$1 ~ /:/ && $1 !~ /^::ffff:/ {print $1; exit}' || true)"
dns_ok=1
if [[ -z "$box_ip" || "$box_ip" != "$dns_ip" ]]; then
  echo "A record: $AR_DOMAIN -> '${dns_ip:-nothing}', but this box is '${box_ip:-unknown}'."
  dns_ok=0
fi
if [[ -n "$dns_ip6" ]]; then
  echo "AAAA record: $AR_DOMAIN -> $dns_ip6. Let's Encrypt may validate over IPv6; remove the AAAA record unless it is this box."
  dns_ok=0
fi
if (( dns_ok )); then
  echo "$AR_DOMAIN -> $dns_ip (this box)"
elif [[ "$AR_FORCE" == "1" ]]; then
  echo "WARNING: continuing anyway (AR_FORCE=1); HTTPS works once DNS is right."
else
  die "fix DNS first (or wait for it to propagate), then re-run. AR_FORCE=1 skips this check."
fi

say "3/7 swap (the image build needs more than 1 GB RAM)"
if swapon --show --noheadings | grep -q .; then
  echo "swap already on"
else
  sudo rm -f /swapfile
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo "2 GB swap added"
fi

say "4/7 Docker + git (Ubuntu packages; waits for the boot-time updater's lock)"
"${APT[@]}" update
"${APT[@]}" install docker.io docker-compose-v2 git curl >/dev/null
sudo systemctl enable --now docker >/dev/null
sudo docker --version

say "5/7 code ($AR_REF)"
if [[ ! -d "$AR_DIR/.git" ]]; then
  sudo mkdir -p "$AR_DIR"
  sudo git -C "$AR_DIR" init --quiet
  sudo git -C "$AR_DIR" remote add origin "$AR_REPO"
fi
sudo git -C "$AR_DIR" fetch --quiet --depth 1 origin "$AR_REF"
sudo git -C "$AR_DIR" checkout --quiet --force FETCH_HEAD
echo "building commit $(sudo git -C "$AR_DIR" rev-parse HEAD)"

say "6/7 build + start (first build takes several minutes on a small box)"
cd "$AR_DIR/deploy/hosted"
env_file=".env"
sudo touch "$env_file"
sudo chmod 600 "$env_file"
if sudo grep -q '^AR_DOMAIN=' "$env_file"; then
  sudo sed -i "s|^AR_DOMAIN=.*|AR_DOMAIN=$AR_DOMAIN|" "$env_file"
else
  echo "AR_DOMAIN=$AR_DOMAIN" | sudo tee -a "$env_file" >/dev/null
fi
sudo docker compose up -d --build --remove-orphans

say "7/7 health (waits up to 10 min for the HTTPS certificate)"
for _ in $(seq 1 120); do
  if health="$(curl -fsS --max-time 5 "https://$AR_DOMAIN/healthz" 2>/dev/null)"; then
    echo "https://$AR_DOMAIN/healthz -> $health"
    cat <<EOF

Done. Create a token for each user (shown ONCE):

  cd $AR_DIR/deploy/hosted && sudo docker compose exec server agent-recall-server token create --uid <uid> --label "<device>"

Agents connect to:  https://$AR_DOMAIN/mcp   with header  Authorization: Bearer <token>
Never run 'docker compose down -v' (it deletes all users' memory).
EOF
    exit 0
  fi
  sleep 5
done

echo "Still starting: https://$AR_DOMAIN/healthz did not answer within 10 minutes."
echo "Check: DNS A record, Lightsail firewall (80 + 443 open), then:"
echo "  cd $AR_DIR/deploy/hosted && sudo docker compose ps && sudo docker compose logs --tail 50 caddy server"
exit 1
