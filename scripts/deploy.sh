#!/usr/bin/env sh
set -eu

# One-command production update for ai-channel-manager.
# Defaults target a PM2 process named "ai-channel-manager".
#
# Common usage:
#   sh scripts/deploy.sh
#   PORT=3642 sh scripts/deploy.sh
#   PM2_NAME=ai-channel-manager sh scripts/deploy.sh
#   SERVICE_MANAGER=systemd SERVICE_NAME=ai-channel-manager sh scripts/deploy.sh
#   RESTART_CMD='pm2 restart ai-channel-manager --update-env' sh scripts/deploy.sh

PROJECT_DIR=${PROJECT_DIR:-}
BRANCH=${BRANCH:-main}
INSTALL_CMD=${INSTALL_CMD:-npm ci}
BUILD_CMD=${BUILD_CMD:-npm run build}
SERVICE_MANAGER=${SERVICE_MANAGER:-pm2}
SERVICE_NAME=${SERVICE_NAME:-ai-channel-manager}
PM2_NAME=${PM2_NAME:-ai-channel-manager}
SERVICE_USER=${SERVICE_USER:-}
INSTALL_SYSTEMD_SERVICE=${INSTALL_SYSTEMD_SERVICE:-auto}
RESTART_CMD=${RESTART_CMD:-}
APP_HOST=${HOST:-127.0.0.1}
APP_PORT=${PORT:-3642}
APP_NODE_ENV=${NODE_ENV:-production}
HEALTH_URL=${HEALTH_URL:-}
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

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  command_exists sudo || fail "sudo is required to manage systemd services"
  sudo "$@"
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

is_valid_port() {
  port=$1
  case "$port" in
    '' | *[!0-9]*)
      return 1
      ;;
  esac

  if [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null; then
    return 0
  fi

  return 1
}

resolve_new_service_port() {
  if [ -n "$APP_PORT" ]; then
    is_valid_port "$APP_PORT" || fail "Invalid PORT: $APP_PORT. Use a number from 1 to 65535."
    return
  fi

  if [ ! -t 0 ]; then
    fail "PORT is required when creating the systemd service in non-interactive mode. Example: PORT=3642 sh scripts/deploy.sh"
  fi

  while :; do
    printf '%s' "Enter service port (1-65535): " >&2
    IFS= read -r input_port || fail "Failed to read service port"
    if is_valid_port "$input_port"; then
      APP_PORT=$input_port
      return
    fi
    warn "Invalid port: $input_port. Use a number from 1 to 65535."
  done
}

set_default_health_url_from_port() {
  if [ -z "$HEALTH_URL" ] && [ -n "$1" ]; then
    HEALTH_URL="http://127.0.0.1:$1/api/auth/status"
  fi
}

ensure_health_url() {
  if [ -n "$HEALTH_URL" ]; then
    return
  fi

  if [ -n "$APP_PORT" ] && is_valid_port "$APP_PORT"; then
    set_default_health_url_from_port "$APP_PORT"
    return
  fi

  HEALTH_URL="http://127.0.0.1:3642/api/auth/status"
}

ensure_runtime_config_exists() {
  if [ ! -f config.json ]; then
    fail "Missing config.json. Copy config.example.json to config.json and set accessPassword before starting the service."
  fi
}

validate_service_name() {
  case "$SERVICE_NAME" in
    '' | */*)
      fail "Unsupported SERVICE_NAME: $SERVICE_NAME"
      ;;
  esac
}

resolve_service_user() {
  if [ -n "$SERVICE_USER" ]; then
    printf '%s\n' "$SERVICE_USER"
    return
  fi

  id -un 2>/dev/null || whoami
}

resolve_node_path() {
  command_exists node || fail "node is required"
  node_cmd=$(command -v node)

  if command_exists readlink; then
    resolved_node=$(readlink -f "$node_cmd" 2>/dev/null || true)
    if [ -n "$resolved_node" ]; then
      printf '%s\n' "$resolved_node"
      return
    fi
  fi

  printf '%s\n' "$node_cmd"
}

systemd_escape_value() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/%/%%/g'
}

systemd_available() {
  command_exists systemctl || return 1
  systemctl show-environment >/dev/null 2>&1
}

systemd_unit_exists() {
  command_exists systemctl || return 1
  systemctl cat "$SERVICE_NAME.service" >/dev/null 2>&1
}

systemd_service_port() {
  command_exists systemctl || return 1
  env_line=$(systemctl show "$SERVICE_NAME.service" -p Environment --value 2>/dev/null || true)
  for env_item in $env_line; do
    case "$env_item" in
      PORT=*)
        unit_port=${env_item#PORT=}
        if is_valid_port "$unit_port"; then
          printf '%s\n' "$unit_port"
          return 0
        fi
        ;;
    esac
  done

  return 1
}

remember_systemd_health_port() {
  if [ -n "$HEALTH_URL" ]; then
    return
  fi

  unit_port=$(systemd_service_port || true)
  if [ -n "$unit_port" ]; then
    set_default_health_url_from_port "$unit_port"
  fi
}

pm2_process_exists() {
  command_exists pm2 || return 1
  pm2 describe "$PM2_NAME" >/dev/null 2>&1
}

pm2_process_online() {
  command_exists pm2 || return 1
  pm2 describe "$PM2_NAME" 2>/dev/null | grep -Eq 'status.*online'
}

wait_for_pm2_online() {
  i=1
  while [ "$i" -le 10 ]; do
    if pm2_process_online; then
      return
    fi
    printf '%s\n' "Waiting for PM2 process to be online... ($i/10)"
    sleep 1
    i=$((i + 1))
  done

  pm2 status "$PM2_NAME" || true
  fail "PM2 process is not online: $PM2_NAME"
}

create_systemd_service() {
  validate_service_name
  systemd_available || fail "systemd is not available. Set SERVICE_MANAGER=pm2, SERVICE_MANAGER=none, or RESTART_CMD='your restart command'."
  if [ "$INSTALL_SYSTEMD_SERVICE" = "0" ]; then
    fail "systemd service not found: $SERVICE_NAME.service. INSTALL_SYSTEMD_SERVICE=0 prevents automatic service creation."
  fi

  ensure_runtime_config_exists
  resolve_new_service_port
  set_default_health_url_from_port "$APP_PORT"

  service_user=$(resolve_service_user)
  node_path=$(resolve_node_path)
  project_dir=$(pwd)
  unit_path="/etc/systemd/system/$SERVICE_NAME.service"

  unit_project_dir=$(systemd_escape_value "$project_dir")
  unit_node_path=$(systemd_escape_value "$node_path")
  unit_host=$(systemd_escape_value "$APP_HOST")
  unit_port=$(systemd_escape_value "$APP_PORT")
  unit_node_env=$(systemd_escape_value "$APP_NODE_ENV")
  unit_service_user=$(systemd_escape_value "$service_user")

  tmp_unit=$(mktemp) || fail "Failed to create temporary systemd unit file"
  cat >"$tmp_unit" <<EOF
[Unit]
Description=AI Channel Manager
After=network.target

[Service]
Type=simple
User=$unit_service_user
WorkingDirectory=$unit_project_dir
Environment="HOST=$unit_host"
Environment="PORT=$unit_port"
Environment="NODE_ENV=$unit_node_env"
ExecStart=$unit_node_path $unit_project_dir/dist/server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  log "Creating systemd service: $SERVICE_NAME"
  if ! run_as_root install -m 0644 "$tmp_unit" "$unit_path"; then
    rm -f "$tmp_unit"
    fail "Failed to install $unit_path. Make sure this user has sudo permission."
  fi
  rm -f "$tmp_unit"

  run_as_root systemctl daemon-reload
  run_as_root systemctl enable "$SERVICE_NAME"
}

restart_with_systemd() {
  if systemd_unit_exists; then
    remember_systemd_health_port
  else
    create_systemd_service
  fi

  ensure_runtime_config_exists
  log "Restarting systemd service: $SERVICE_NAME"
  run_as_root systemctl restart "$SERVICE_NAME"
  run_as_root systemctl status "$SERVICE_NAME" --no-pager -l || true
}

restart_with_pm2() {
  command_exists pm2 || fail "pm2 is required"
  ensure_runtime_config_exists
  is_valid_port "$APP_PORT" || fail "Invalid PORT: $APP_PORT. Use a number from 1 to 65535."
  set_default_health_url_from_port "$APP_PORT"

  log "Restarting PM2 process: $PM2_NAME"
  if pm2_process_exists; then
    HOST="$APP_HOST" PORT="$APP_PORT" NODE_ENV="$APP_NODE_ENV" pm2 restart "$PM2_NAME" --update-env
  else
    HOST="$APP_HOST" PORT="$APP_PORT" NODE_ENV="$APP_NODE_ENV" pm2 start dist/server/index.js --name "$PM2_NAME"
  fi
  wait_for_pm2_online
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
      if pm2_process_exists; then
        restart_with_pm2
      elif systemd_unit_exists; then
        restart_with_systemd
      elif systemd_available; then
        restart_with_systemd
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

  ensure_health_url
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
