#!/usr/bin/env sh
set -eu

# One-command production update for ai-channel-manager.
# Defaults target a systemd service named "ai-channel-manager".
#
# Common usage:
#   sh scripts/deploy.sh
#   SERVICE_NAME=ai-channel-manager sh scripts/deploy.sh
#   RESTART_CMD='sudo systemctl restart ai-channel-manager' sh scripts/deploy.sh
#   SERVICE_MANAGER=pm2 PM2_NAME=ai-channel-manager sh scripts/deploy.sh

PROJECT_DIR=${PROJECT_DIR:-}
BRANCH=${BRANCH:-main}
INSTALL_CMD=${INSTALL_CMD:-npm ci}
BUILD_CMD=${BUILD_CMD:-npm run build}
SERVICE_MANAGER=${SERVICE_MANAGER:-auto}
SERVICE_NAME=${SERVICE_NAME:-ai-channel-manager}
PM2_NAME=${PM2_NAME:-ai-channel-manager}
RESTART_CMD=${RESTART_CMD:-}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8787/api/auth/status}
HEALTH_RETRIES=${HEALTH_RETRIES:-20}
HEALTH_SLEEP=${HEALTH_SLEEP:-2}
SKIP_GIT_PULL=${SKIP_GIT_PULL:-0}
SKIP_INSTALL=${SKIP_INSTALL:-0}
SKIP_BUILD=${SKIP_BUILD:-0}
SKIP_HEALTHCHECK=${SKIP_HEALTHCHECK:-0}

log() {
  printf '%s\n' "==> $*"
}

warn() {
  printf '%s\n' "WARN: $*" >&2
}

fail() {
  printf '%s\n' "ERROR: $*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

resolve_project_dir() {
  if [ -n "$PROJECT_DIR" ]; then
    cd "$PROJECT_DIR" || fail "PROJECT_DIR does not exist: $PROJECT_DIR"
    return
  fi

  script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  cd "$script_dir/.." || fail "Cannot enter project directory"
}

run_git_update() {
  if [ "$SKIP_GIT_PULL" = "1" ]; then
    log "Skipping git pull"
    return
  fi

  command_exists git || fail "git is required"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "Not inside a git work tree"

  current_branch=$(git branch --show-current 2>/dev/null || true)
  if [ -n "$current_branch" ] && [ "$current_branch" != "$BRANCH" ]; then
    log "Switching branch: $current_branch -> $BRANCH"
    git fetch origin "$BRANCH"
    git switch "$BRANCH"
  else
    log "Fetching latest origin/$BRANCH"
    git fetch origin "$BRANCH"
  fi

  log "Updating code with fast-forward only"
  git pull --ff-only origin "$BRANCH"
}

run_install() {
  if [ "$SKIP_INSTALL" = "1" ]; then
    log "Skipping dependency install"
    return
  fi

  command_exists npm || fail "npm is required"
  log "Installing dependencies: $INSTALL_CMD"
  sh -c "$INSTALL_CMD"
}

run_build() {
  if [ "$SKIP_BUILD" = "1" ]; then
    log "Skipping build"
    return
  fi

  log "Building project: $BUILD_CMD"
  sh -c "$BUILD_CMD"
}

systemd_unit_exists() {
  command_exists systemctl || return 1
  systemctl list-unit-files "$SERVICE_NAME.service" >/dev/null 2>&1
}

pm2_process_exists() {
  command_exists pm2 || return 1
  pm2 describe "$PM2_NAME" >/dev/null 2>&1
}

restart_with_systemd() {
  systemd_unit_exists || fail "systemd service not found: $SERVICE_NAME.service"
  log "Restarting systemd service: $SERVICE_NAME"
  sudo systemctl restart "$SERVICE_NAME"
  sudo systemctl status "$SERVICE_NAME" --no-pager -l || true
}

restart_with_pm2() {
  command_exists pm2 || fail "pm2 is required"
  log "Restarting PM2 process: $PM2_NAME"
  if pm2_process_exists; then
    pm2 restart "$PM2_NAME" --update-env
  else
    pm2 start npm --name "$PM2_NAME" -- start
  fi
  pm2 save
  pm2 status "$PM2_NAME" || true
}

run_restart() {
  if [ -n "$RESTART_CMD" ]; then
    log "Restarting with custom command: $RESTART_CMD"
    sh -c "$RESTART_CMD"
    return
  fi

  case "$SERVICE_MANAGER" in
    systemd)
      restart_with_systemd
      ;;
    pm2)
      restart_with_pm2
      ;;
    none)
      log "Skipping restart because SERVICE_MANAGER=none"
      ;;
    auto)
      if systemd_unit_exists; then
        restart_with_systemd
      elif pm2_process_exists; then
        restart_with_pm2
      else
        fail "No known process manager found. Set SERVICE_MANAGER=systemd, SERVICE_MANAGER=pm2, SERVICE_MANAGER=none, or RESTART_CMD='your restart command'."
      fi
      ;;
    *)
      fail "Unsupported SERVICE_MANAGER: $SERVICE_MANAGER"
      ;;
  esac
}

run_healthcheck() {
  if [ "$SKIP_HEALTHCHECK" = "1" ]; then
    log "Skipping health check"
    return
  fi

  if ! command_exists curl; then
    warn "curl is not installed; skipping health check"
    return
  fi

  log "Checking service health: $HEALTH_URL"
  i=1
  while [ "$i" -le "$HEALTH_RETRIES" ]; do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      log "Health check passed"
      return
    fi
    printf '%s\n' "Waiting for service... ($i/$HEALTH_RETRIES)"
    sleep "$HEALTH_SLEEP"
    i=$((i + 1))
  done

  fail "Health check failed: $HEALTH_URL"
}

main() {
  resolve_project_dir
  log "Project directory: $(pwd)"
  run_git_update
  run_install
  run_build
  run_restart
  run_healthcheck
  log "Deploy finished"
}

main "$@"
