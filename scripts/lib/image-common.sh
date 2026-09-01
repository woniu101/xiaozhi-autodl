#!/usr/bin/env bash

XIAOZHI_AUTODL_ROOT=${XIAOZHI_AUTODL_ROOT:-/root/xiaozhi-autodl}
XIAOZHI_AUTODL_RUNTIME=${XIAOZHI_AUTODL_RUNTIME:-/root/autodl-tmp/xiaozhi-autodl}
XIAOZHI_DATA_MOUNT=${XIAOZHI_DATA_MOUNT:-/root/autodl-tmp}
XIAOZHI_DB=${XIAOZHI_DB:-xiaozhi_esp32_server}
XIAOZHI_SUPERVISOR_CONFIG="$XIAOZHI_AUTODL_ROOT/config/supervisor/supervisord.conf"

image_log() {
  printf '[image] %s\n' "$*"
}

image_die() {
  printf '[image] ERROR: %s\n' "$*" >&2
  exit 1
}

require_root() {
  [[ ${EUID:-$(id -u)} -eq 0 ]] || image_die '必须使用 root 执行'
}

require_data_mount() {
  local target
  target=$(findmnt -n -o TARGET -T "$XIAOZHI_DATA_MOUNT" 2>/dev/null || true)
  [[ "$target" == "$XIAOZHI_DATA_MOUNT" ]] || image_die "$XIAOZHI_DATA_MOUNT 不是独立挂载的数据盘"
}

install_runtime_directories() {
  local runtime=$XIAOZHI_AUTODL_RUNTIME
  install -d -m 0755 \
    "$runtime" \
    "$runtime/config" \
    "$runtime/logs" \
    "$runtime/run" \
    "$runtime/state" \
    "$runtime/uploads" \
    "$runtime/voices" \
    "$runtime/outputs" \
    "$runtime/outputs/xiaozhi-server" \
    "$runtime/outputs/index-tts" \
    "$runtime/character_styles" \
    "$runtime/index-tts" \
    "$runtime/index-tts/reference" \
    "$runtime/index-tts/voices" \
    "$runtime/backups"
  install -d -m 0700 "$runtime/secrets" "$runtime/dev-state"
}

directory_has_payload() {
  local directory=$1
  find "$directory" -mindepth 1 -maxdepth 1 ! -name '.staging' -print -quit 2>/dev/null | grep -q .
}

seed_runtime_data() {
  local runtime=$XIAOZHI_AUTODL_RUNTIME
  local style_seed=/opt/xiaozhi-esp32-server/data/character_styles
  local voice_seed=/root/index-tts

  if ! directory_has_payload "$runtime/character_styles" && [[ -d "$style_seed" ]]; then
    cp -a "$style_seed"/. "$runtime/character_styles"/
    image_log '已初始化人物资源 seed'
  fi

  if [[ ! -s "$runtime/index-tts/voices/voices.json" ]] && [[ -s "$voice_seed/voices/voices.json" ]]; then
    cp -a "$voice_seed/voices"/. "$runtime/index-tts/voices"/
    cp -a "$voice_seed/reference"/. "$runtime/index-tts/reference"/
    image_log '已初始化 IndexTTS 音色 seed'
  fi
}

mysql_ready() {
  /usr/bin/mysqladmin --defaults-file=/etc/mysql/debian.cnf ping >/dev/null 2>&1
}

ensure_mysql_running() {
  mysql_ready || /usr/sbin/service mysql start >/dev/null
  local attempt
  for attempt in $(seq 1 60); do
    mysql_ready && return 0
    sleep 1
  done
  image_die 'MySQL 在 60 秒内未就绪'
}

stop_supervisor_services() {
  if /root/miniconda3/bin/supervisorctl -c "$XIAOZHI_SUPERVISOR_CONFIG" pid >/dev/null 2>&1; then
    /root/miniconda3/bin/supervisorctl -c "$XIAOZHI_SUPERVISOR_CONFIG" stop all >/dev/null || true
    /root/miniconda3/bin/supervisorctl -c "$XIAOZHI_SUPERVISOR_CONFIG" shutdown >/dev/null || true
  fi
}

write_repo_versions() {
  local target=$1
  /usr/bin/python3 - "$target" <<'PY'
import json
import subprocess
import sys
from datetime import datetime, timezone

target = sys.argv[1]
repos = [
    ("xiaozhi-autodl", "/root/xiaozhi-autodl", "main"),
    ("xiaozhi-esp32-server", "/root/xiaozhi-esp32-server", "mvp"),
    ("index-tts", "/root/index-tts", "main"),
]
payload = {"createdAt": datetime.now(timezone.utc).isoformat(), "repositories": []}
for name, path, branch in repos:
    head = subprocess.check_output(["git", "-C", path, "rev-parse", "HEAD"], text=True).strip()
    payload["repositories"].append({"name": name, "path": path, "branch": branch, "commit": head})
with open(target, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
PY
  chmod 0644 "$target"
}
