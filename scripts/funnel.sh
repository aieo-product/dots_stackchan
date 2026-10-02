#!/bin/bash
# Publishes the dedicated OAuth/MCP listener only. Never point this at a device gateway.
set -euo pipefail

fail() { printf '%s\n' "$1" >&2; exit 1; }
action=${1:-status}
[ "$#" -eq 0 ] || shift
port=${FUNNEL_PORT:-8443}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) [ "$#" -ge 2 ] || fail 'Missing --port value.'; port=$2; shift 2 ;;
    *) fail 'Usage: funnel.sh up|down|status [--port 443|8443|10000]' ;;
  esac
done
case "$action" in up|down|status) ;; *) fail 'Unknown action.' ;; esac
case "$port" in 443|8443|10000) ;; *) fail 'Funnel port must be 443, 8443 or 10000.' ;; esac
command -v tailscale >/dev/null || fail 'Tailscale CLI is required.'
command -v node >/dev/null || fail 'Node.js is required.'

# Do not emit raw status JSON, CLI diagnostics, DNS names or proxy targets.
if [ "$action" = status ]; then
  tailscale funnel status --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", chunk => raw += chunk);
    process.stdin.on("end", () => {
      try {
        const config = JSON.parse(raw);
        const port = process.argv[1];
        const configs = [config, ...Object.values(config.Foreground ?? {})];
        const publicPort = configs.some(item => Object.entries(item.AllowFunnel ?? {}).some(([key, enabled]) => key.endsWith(`:${port}`) && enabled));
        const occupied = configs.some(item => Boolean(item.TCP?.[port]) || Object.keys(item.Web ?? {}).some(key => key.endsWith(`:${port}`)));
        console.log(`Port ${port}: ${publicPort ? "Funnel enabled" : occupied ? "configured, private" : "unused"}; hostname: <your-host>`);
      } catch { console.error("Cannot read Funnel status."); process.exitCode = 1; }
    });
  ' "$port" || fail 'Funnel status failed.'
  exit 0
fi

[[ ${MCP_PORT:-} =~ ^[0-9]{1,5}$ ]] || fail 'Set MCP_PORT to the dedicated OAuth/MCP loopback listener.'
[ "$((10#$MCP_PORT))" -ge 1 ] && [ "$((10#$MCP_PORT))" -le 65535 ] || fail 'Invalid MCP_PORT.'
target="http://127.0.0.1:$MCP_PORT"

# Obtain DNS privately; use it only to match runtime configuration.
dns=$(tailscale status --json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", chunk => raw += chunk);
  process.stdin.on("end", () => {
    try {
      const dns = JSON.parse(raw).Self.DNSName.replace(/\.$/, "");
      if (!/^[a-z0-9.-]+\.ts\.net$/.test(dns)) throw new Error();
      process.stdout.write(dns);
    } catch { process.exitCode = 1; }
  });
') || fail 'Cannot determine the Tailscale DNS name.'

ownership=$(tailscale funnel status --json 2>/dev/null | node -e '
  let raw = "";
  process.stdin.on("data", chunk => raw += chunk);
  process.stdin.on("end", () => {
    try {
      const config = JSON.parse(raw);
      const [port, dns, target] = process.argv.slice(1);
      const foregroundConflict = Object.values(config.Foreground ?? {}).some(item =>
        Boolean(item.TCP?.[port]) || Object.keys(item.Web ?? {}).some(key => key.endsWith(`:${port}`)) ||
        Object.entries(item.AllowFunnel ?? {}).some(([key, flag]) => key.endsWith(`:${port}`) && flag));
      if (foregroundConflict) { console.log("conflict"); return; }
      const webEntries = Object.entries(config.Web ?? {}).filter(([key]) => key.endsWith(`:${port}`));
      const tcp = config.TCP?.[port];
      const flags = Object.entries(config.AllowFunnel ?? {}).filter(([key]) => key.endsWith(`:${port}`));
      if (!tcp && !webEntries.length && !flags.some(([, flag]) => flag)) { console.log("empty"); return; }
      const handlers = webEntries[0]?.[1]?.Handlers;
      const owned = tcp?.HTTPS === true && Object.keys(tcp).length === 1 &&
        webEntries.length === 1 && webEntries[0][0] === `${dns}:${port}` &&
        handlers && Object.keys(handlers).length === 1 && handlers["/"]?.Proxy === target &&
        Object.keys(handlers["/"]).length === 1 &&
        config.AllowFunnel?.[`${dns}:${port}`] === true;
      console.log(owned ? "owned" : "conflict");
    } catch { process.exitCode = 1; }
  });
' "$port" "$dns" "$target") || fail 'Cannot inspect Funnel configuration.'
[ "$ownership" != conflict ] || fail 'Selected port belongs to another configuration; refusing to change it.'

if [ "$action" = down ]; then
  if [ "$ownership" = owned ]; then
    tailscale funnel --bg --https="$port" --set-path=/ off >/dev/null 2>&1 || fail 'Funnel shutdown failed.'
  fi
  printf 'MCP Funnel on port %s is closed; other ports unchanged.\n' "$port"
  exit 0
fi

public="https://$dns"
[ "$port" = 443 ] || public="$public:$port"
[ "${MCP_PUBLIC_URL:-}" = "$public/mcp" ] || fail 'MCP_PUBLIC_URL must match this host, selected HTTPS port and /mcp.'
# Refuse to publish an unprotected listener or a port that also serves /device.
node --input-type=module - "$target" <<'JS' || fail 'OAuth/MCP preflight failed; nothing published.'
const target = process.argv[2];
try {
  const options = { signal: AbortSignal.timeout(5000), redirect: "error" };
  const mcp = await fetch(`${target}/mcp`, options);
  const metadataUrl = `${new URL(process.env.MCP_PUBLIC_URL).origin}/.well-known/oauth-protected-resource/mcp`;
  if (mcp.status !== 401 || !mcp.headers.get("www-authenticate")?.includes(`resource_metadata="${metadataUrl}"`)) throw new Error();
  const device = await fetch(`${target}/device`, options);
  if (device.status !== 404) throw new Error();
  const metadata = await fetch(`${target}/.well-known/oauth-protected-resource/mcp`, options);
  if (metadata.status !== 200 || (await metadata.json()).resource !== process.env.MCP_PUBLIC_URL) throw new Error();
} catch { process.exitCode = 1; }
JS
tailscale funnel --bg --https="$port" --set-path=/ "$target" >/dev/null 2>&1 || fail 'Funnel setup failed.'
suffix=":$port"
[ "$port" != 443 ] || suffix=""
printf 'MCP Funnel enabled: https://<your-host>.<your-tailnet>.ts.net%s/mcp; /device remains private.\n' "$suffix"
