#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH_FILE="$SCRIPT_DIR/.funnel-path"
PORT=8790

mask_hosts() {
  sed -E 's#https://[^ /]+\.ts\.net#https://<your-host>.<your-tailnet>.ts.net#g; s#[[:alnum:]-]+\.[[:alnum:]-]+\.ts\.net#<your-host>.<your-tailnet>.ts.net#g'
}

case "${1:-}" in
  up)
    random_path=$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 24)
    mount_path="/spike-$random_path"
    tailscale funnel --bg --set-path "$mount_path" "$PORT" >/dev/null
    printf '%s\n' "$mount_path" >"$PATH_FILE"
    printf 'Public MCP URL: https://<your-host>.<your-tailnet>.ts.net%s/mcp\n' "$mount_path"
    printf 'Run `tailscale funnel status` locally to see the real URL.\n'
    ;;
  down)
    if [ ! -f "$PATH_FILE" ]; then
      printf 'No saved Funnel path. Nothing was changed.\n' >&2
      exit 1
    fi
    mount_path=$(cat "$PATH_FILE")
    tailscale funnel --bg --set-path "$mount_path" off
    rm -f "$PATH_FILE"
    printf 'Disabled Funnel path: %s\n' "$mount_path"
    ;;
  status)
    tailscale funnel status | mask_hosts
    ;;
  *)
    printf 'Usage: %s {up|down|status}\n' "$0" >&2
    exit 2
    ;;
esac
