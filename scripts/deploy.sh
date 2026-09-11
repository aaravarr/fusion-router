#!/usr/bin/env bash
# Build in an isolated tree, then switch the verified runtime tree atomically.
# The existing service and .next tree remain untouched until every build guard passes.
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIVE="$PROJ/.next"
STAGING="$PROJ/.next-staging"
PREV="$PROJ/.next-prev"

SWITCH_ATTEMPTED=0
SERVICE_STOPPED=0
PREV_CLEARED=0
LIVE_MOVED=0
STAGING_MOVED=0
ROLLBACK_ATTEMPTED=0

usage() {
  cat <<'USAGE'
用法：scripts/deploy.sh [--help]

执行一次零停机部署：拉取代码、检查磁盘余量，在隔离的 staging 目录执行
webpack 构建并验证 standalone 运行树；随后短暂停止服务，原子切换 .next，
启动新版本并执行 HTTP 200 冒烟检查。启动或冒烟失败会自动切回上一版本。

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

check_disk_space() {
  local available_kb
  if ! available_kb="$(df -Pk "$PROJ" | awk 'NR == 2 { print $4; exit }')"; then
    printf '[deploy] FATAL: unable to inspect free disk space\n' >&2
    return 1
  fi
  if [[ ! "$available_kb" =~ ^[0-9]+$ ]]; then
    printf '[deploy] FATAL: unable to parse free disk space: %s\n' "$available_kb" >&2
    return 1
  fi
  if (( available_kb < 5 * 1024 * 1024 )); then
    printf '[deploy] FATAL: less than 5 GiB is available on the project filesystem (%s KiB)\n' "$available_kb" >&2
    return 1
  fi
  printf '[deploy] free disk space: %s KiB\n' "$available_kb"
}

verify_running() {
  local active_status
  local http_status

  if ! active_status="$(sudo systemctl is-active "$DEPLOY_SERVICE")"; then
    printf '[deploy] service is not active: %s\n' "${active_status:-unknown}" >&2
    return 1
  fi
  if [[ "$active_status" != 'active' ]]; then
    printf '[deploy] service state is %s, expected active\n' "$active_status" >&2
    return 1
  fi

  if ! http_status="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DEPLOY_PORT}/")"; then
    printf '[deploy] HTTP smoke request failed\n' >&2
    return 1
  fi
  printf '[deploy] HTTP smoke status: %s\n' "$http_status"
  if [[ "$http_status" != '200' ]]; then
    printf '[deploy] HTTP smoke expected 200, got %s\n' "$http_status" >&2
    return 1
  fi
}

failed_tree_path() {
  local candidate="$PROJ/.next-failed-$(date +%Y%m%d-%H%M%S)-$$"
  while [[ -e "$candidate" || -L "$candidate" ]]; do
    candidate="${candidate}-1"
  done
  printf '%s\n' "$candidate"
}

rollback_deployment() {
  local reason="$1"
  local rollback_status=0
  local failed_tree

  if (( ROLLBACK_ATTEMPTED == 1 )); then
    return 1
  fi
  ROLLBACK_ATTEMPTED=1
  printf '[deploy] rollback requested: %s\n' "$reason" >&2

  # Stopping is safe even when the failed start left the unit inactive; keep
  # trying the filesystem recovery so .next is never intentionally left absent.
  if (( SWITCH_ATTEMPTED == 1 )); then
    if sudo systemctl stop "$DEPLOY_SERVICE"; then
      SERVICE_STOPPED=1
    else
      printf '[deploy] rollback warning: could not stop service\n' >&2
      rollback_status=1
    fi
  fi

  # If this deployment moved the old tree, keep the failed new tree for
  # inspection and restore the old tree from the same-filesystem backup.
  if (( LIVE_MOVED == 1 )); then
    if [[ -e "$LIVE" || -L "$LIVE" ]]; then
      failed_tree="$(failed_tree_path)"
      if mv -- "$LIVE" "$failed_tree"; then
        printf '[deploy] failed tree preserved at %s\n' "$failed_tree" >&2
      else
        printf '[deploy] rollback warning: could not preserve failed tree\n' >&2
        rollback_status=1
      fi
    fi

    if [[ ! -e "$LIVE" && ! -L "$LIVE" ]]; then
      if [[ -e "$PREV" || -L "$PREV" ]]; then
        if mv -- "$PREV" "$LIVE"; then
          printf '[deploy] previous tree restored\n' >&2
        else
          printf '[deploy] rollback warning: could not restore previous tree\n' >&2
          rollback_status=1
        fi
      else
        printf '[deploy] rollback warning: previous tree is missing\n' >&2
        rollback_status=1
      fi
    fi
  elif (( PREV_CLEARED == 1 )) && [[ ! -e "$LIVE" && ! -L "$LIVE" ]] && [[ -e "$PREV" || -L "$PREV" ]]; then
    # Covers the tiny window after mv removed the old path but before the
    # success marker could be assigned.
    if mv -- "$PREV" "$LIVE"; then
      LIVE_MOVED=1
      printf '[deploy] previous tree restored\n' >&2
    else
      printf '[deploy] rollback warning: could not restore previous tree\n' >&2
      rollback_status=1
    fi
  fi

  if [[ -e "$LIVE" || -L "$LIVE" ]]; then
    if sudo systemctl start "$DEPLOY_SERVICE"; then
      SERVICE_STOPPED=0
      sleep 2
      if verify_running; then
        printf '[deploy] 已回滚：previous .next is serving\n' >&2
      else
        printf '[deploy] rollback verification failed\n' >&2
        rollback_status=1
      fi
    else
      printf '[deploy] rollback warning: could not start previous service\n' >&2
      rollback_status=1
    fi
  else
    printf '[deploy] rollback failed: .next is missing\n' >&2
    rollback_status=1
  fi

  return "$rollback_status"
}

prepare_staging() {
  echo '=== clean staging ==='
  rm -rf -- "$STAGING"

  echo '=== disk space guard ==='
  check_disk_space

  echo '=== webpack staging build ==='
  export NEXT_TELEMETRY_DISABLED=1
  # distDir must stay relative: Next resolves it with path.join(projectDir, distDir),
  # and path.join keeps absolute segments, which would nest the output directory.
  NEXT_DIST_DIR=".next-staging" npx next build --webpack

  echo '=== remove traced data shell ==='
  if [[ -e "$STAGING/standalone/data" || -L "$STAGING/standalone/data" ]]; then
    rm -rf -- "$STAGING/standalone/data"
  fi

  echo '=== prepare standalone runtime tree ==='
  rm -rf -- "$STAGING/standalone/.next/static"
  mkdir -p -- "$STAGING/standalone/.next"
  cp -r -- "$STAGING/static" "$STAGING/standalone/.next/static"
  rm -rf -- "$STAGING/standalone/public"
  cp -r -- "$PROJ/public" "$STAGING/standalone/public"

  echo '=== guard: staging server.js exists ==='
  test -f "$STAGING/standalone/server.js" || {
    echo '[deploy] FATAL: staging server.js missing; service and live .next were not touched' >&2
    return 1
  }
}

switch_and_verify() {
  echo '=== preflight switch paths ==='
  test -d "$LIVE" || {
    echo '[deploy] FATAL: live .next directory is missing; service was not stopped' >&2
    return 1
  }
  test -d "$STAGING" || {
    echo '[deploy] FATAL: staging directory is missing; service was not stopped' >&2
    return 1
  }

  echo '=== stop service for atomic switch ==='
  SWITCH_ATTEMPTED=1
  if ! sudo systemctl stop "$DEPLOY_SERVICE"; then
    echo '[deploy] FATAL: could not stop service; live .next was not switched' >&2
    return 1
  fi
  SERVICE_STOPPED=1

  echo '=== atomically switch runtime trees ==='
  rm -rf -- "$PREV"
  PREV_CLEARED=1
  mv -- "$LIVE" "$PREV"
  LIVE_MOVED=1
  mv -- "$STAGING" "$LIVE"
  STAGING_MOVED=1

  echo '=== start service ==='
  if ! sudo systemctl start "$DEPLOY_SERVICE"; then
    echo '[deploy] FATAL: new service failed to start; rolling back' >&2
    if ! rollback_deployment 'service start failed'; then
      echo '[deploy] FATAL: rollback could not be verified' >&2
    fi
    return 1
  fi
  SERVICE_STOPPED=0

  sleep 6
  if ! verify_running; then
    echo '[deploy] FATAL: smoke check failed; rolling back' >&2
    if ! rollback_deployment 'HTTP smoke check failed'; then
      echo '[deploy] FATAL: rollback could not be verified' >&2
    fi
    return 1
  fi
}

run_deploy() {
  # Relative paths below (git pull, public, and the Next command) resolve
  # against the repository even when the wrapper is invoked from elsewhere.
  cd "$PROJ"

  echo '=== pull ==='
  if [[ -n "${DEPLOY_GIT_PROXY:-}" ]]; then
    http_proxy="$DEPLOY_GIT_PROXY" \
      https_proxy="$DEPLOY_GIT_PROXY" \
      git pull origin main
  else
    git pull origin main
  fi

  prepare_staging
  switch_and_verify
  echo '=== deploy done ==='
}

on_exit() {
  local exit_status="$1"
  trap - EXIT

  if (( exit_status != 0 && SWITCH_ATTEMPTED == 1 && ROLLBACK_ATTEMPTED == 0 )); then
    # `[[ ... ]]` tests cannot live inside `(( ... ))` arithmetic; combine a
    # numeric flag with real path tests instead of and-ing raw test operators.
    local tree_needs_restore=0
    if (( LIVE_MOVED == 1 )); then
      tree_needs_restore=1
    elif (( PREV_CLEARED == 1 )) && [[ ! -e "$LIVE" && -e "$PREV" ]]; then
      tree_needs_restore=1
    fi

    if (( tree_needs_restore == 1 )); then
      if ! rollback_deployment 'unexpected deployment interruption'; then
        printf '[deploy] FATAL: automatic rollback failed; inspect service state\n' >&2
      fi
    elif (( SWITCH_ATTEMPTED == 1 )); then
      # No tree was moved, so start the unit to leave a definite state even if
      # the stop command itself returned an error after changing its state.
      if sudo systemctl start "$DEPLOY_SERVICE"; then
        SERVICE_STOPPED=0
        printf '[deploy] service restarted after an interrupted switch\n' >&2
      else
        printf '[deploy] FATAL: service could not be restarted\n' >&2
      fi
    fi
  fi

  exit "$exit_status"
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
  trap 'on_exit "$?"' EXIT
  run_deploy
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
