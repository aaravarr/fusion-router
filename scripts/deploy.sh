#!/usr/bin/env bash
# Hardened deployment helper.
#
# Incident background:
# A framework build ignored tracing exclusions and copied the live data/ directory
# into the standalone output.  With a very large dataset, the disk filled before
# the old post-build cleanup could run.  An interrupted build could also leave a
# standalone tree without server.js, causing the service supervisor to restart it
# in a loop.
#
# Hardening kept here: stop the service before building, rename live data to a
# same-filesystem sibling outside the project, restore it from an EXIT trap, move
# any build-created data/ shell aside before restoring the real data, and start
# the service only after server.js has been verified.
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOLD="$(dirname "$PROJ")/.$(basename "$PROJ")-data-hold"
DATA_LIVE="$PROJ/data"
DATA_HELD=0

usage() {
  cat <<'USAGE'
用法：scripts/deploy.sh [--help]

执行一次加固部署：拉取代码、停服务、暂存 live data/、构建、恢复数据、
同步 standalone 静态资源，确认 server.js 存在后启动服务并做 HTTP 冒烟检查。

配置（环境变量优先于仓库根目录的 deploy.local.env）：
  DEPLOY_SERVICE    必填，systemd 单元名。
  DEPLOY_PORT       必填，HTTP 冒烟检查使用的端口。
  DEPLOY_GIT_PROXY  可选；填写后为 git pull 同时设置 HTTP/HTTPS 代理，
                    留空或未设置时直连。

仓库根目录存在 deploy.local.env 时会被 source；不存在时忽略。
缺少任一必填配置，或传入未知参数，脚本会打印本帮助并退出。
USAGE
}

die_with_usage() {
  printf '[deploy] FATAL: %s\n\n' "$1" >&2
  usage >&2
  return 1
}

load_config() {
  local service_env_set="${DEPLOY_SERVICE+x}"
  local service_env_value="${DEPLOY_SERVICE-}"
  local port_env_set="${DEPLOY_PORT+x}"
  local port_env_value="${DEPLOY_PORT-}"
  local proxy_env_set="${DEPLOY_GIT_PROXY+x}"
  local proxy_env_value="${DEPLOY_GIT_PROXY-}"

  if [[ -f "$PROJ/deploy.local.env" ]]; then
    # shellcheck disable=SC1091
    source "$PROJ/deploy.local.env"
  fi

  # Preserve values explicitly supplied by the invoking environment.
  if [[ "$service_env_set" == x ]]; then
    DEPLOY_SERVICE="$service_env_value"
  fi
  if [[ "$port_env_set" == x ]]; then
    DEPLOY_PORT="$port_env_value"
  fi
  if [[ "$proxy_env_set" == x ]]; then
    DEPLOY_GIT_PROXY="$proxy_env_value"
  fi
}

validate_config() {
  if [[ -z "${DEPLOY_SERVICE:-}" ]]; then
    die_with_usage 'DEPLOY_SERVICE is required (set it in the environment or deploy.local.env)'
  fi
  if [[ -z "${DEPLOY_PORT:-}" ]]; then
    die_with_usage 'DEPLOY_PORT is required (set it in the environment or deploy.local.env)'
  fi
  if [[ ! "$DEPLOY_PORT" =~ ^[0-9]+$ ]]; then
    die_with_usage 'DEPLOY_PORT must contain only decimal digits'
  fi
}

restore_data() {
  local original_status="${1:-0}"
  local restore_status=0
  local scratch=''

  if (( DATA_HELD == 1 )); then
    # A successful build can create an empty data/ directory in the project.
    # Move that shell aside so the held live data can take the canonical path.
    if [[ -e "$DATA_LIVE" || -L "$DATA_LIVE" ]]; then
      scratch="$PROJ/data.build-scratch-$(date +%Y%m%d-%H%M%S)"
      while [[ -e "$scratch" || -L "$scratch" ]]; do
        scratch="${scratch}-$$"
      done
      if mv -- "$DATA_LIVE" "$scratch"; then
        echo "[deploy] build-created data moved aside -> $scratch"
      else
        printf '[deploy] FATAL: could not move build-created data aside\n' >&2
        restore_status=1
      fi
    fi

    if (( restore_status == 0 )); then
      if [[ ! -d "$HOLD" ]]; then
        printf '[deploy] FATAL: held live data is missing: %s\n' "$HOLD" >&2
        restore_status=1
      elif mv -- "$HOLD" "$DATA_LIVE"; then
        DATA_HELD=0
        echo "[deploy] live data restored -> $DATA_LIVE"
      else
        printf '[deploy] FATAL: could not restore live data to %s\n' "$DATA_LIVE" >&2
        restore_status=1

        # If the destination move failed after moving a build shell, make a
        # best-effort rollback so live data is not left without its path.
        if [[ -n "$scratch" && ! -e "$DATA_LIVE" && ! -L "$DATA_LIVE" ]]; then
          if [[ -e "$scratch" || -L "$scratch" ]]; then
            if mv -- "$scratch" "$DATA_LIVE"; then
              echo "[deploy] rolled build-created data back -> $DATA_LIVE"
            else
              printf '[deploy] FATAL: rollback of build-created data also failed\n' >&2
            fi
          fi
        fi
      fi
    fi
  fi

  if (( restore_status != 0 )); then
    return "$restore_status"
  fi
  return "$original_status"
}

run_deploy() {
  # Relative paths below (.next, public, npm run build, git pull) all resolve
  # against the cwd, and the wrapper may be invoked from anywhere.
  cd "$PROJ"

  echo '=== pull ==='
  if [[ -n "${DEPLOY_GIT_PROXY:-}" ]]; then
    http_proxy="$DEPLOY_GIT_PROXY" \
      https_proxy="$DEPLOY_GIT_PROXY" \
      git pull origin main
  else
    git pull origin main
  fi

  echo '=== stop service (build wipes .next) ==='
  sudo systemctl stop "$DEPLOY_SERVICE"

  echo '=== move live data aside ==='
  if [[ -e "$HOLD" || -L "$HOLD" ]]; then
    die_with_usage "hold path already exists; inspect it before retrying: $HOLD"
  fi
  if [[ ! -d "$DATA_LIVE" ]]; then
    die_with_usage "live data directory is missing: $DATA_LIVE"
  fi
  mv -- "$DATA_LIVE" "$HOLD"
  DATA_HELD=1

  # Do not continue unless data/ is genuinely absent from the project.
  if [[ -e "$DATA_LIVE" || -L "$DATA_LIVE" ]]; then
    die_with_usage "live data path still exists after move: $DATA_LIVE"
  fi
  if [[ ! -d "$HOLD" ]]; then
    die_with_usage "held live data directory is missing after move: $HOLD"
  fi

  echo '=== build ==='
  export NEXT_TELEMETRY_DISABLED=1
  npm run build
  rm -rf -- .next/standalone/data

  echo '=== restore live data ==='
  restore_data 0

  echo '=== sync standalone assets ==='
  rm -rf -- .next/standalone/.next/static
  mkdir -p -- .next/standalone/.next
  cp -r -- .next/static .next/standalone/.next/static
  rm -rf -- .next/standalone/public
  cp -r -- public .next/standalone/public

  echo '=== guard: server.js exists ==='
  test -f .next/standalone/server.js || {
    echo '[deploy] FATAL: server.js missing, service left stopped' >&2
    exit 1
  }

  echo '=== start service ==='
  sudo systemctl start "$DEPLOY_SERVICE"
  sleep 6
  sudo systemctl is-active "$DEPLOY_SERVICE"
  curl -sI "http://127.0.0.1:${DEPLOY_PORT}/" | head -n 1
  echo '=== deploy done ==='
}

main() {
  if [[ "${1:-}" == '--help' ]]; then
    usage
    return 0
  fi
  if (( $# > 0 )); then
    die_with_usage "unknown argument: $1"
  fi

  load_config
  validate_config
  trap 'restore_data "$?"' EXIT
  run_deploy
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
