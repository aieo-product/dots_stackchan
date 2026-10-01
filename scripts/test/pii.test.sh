#!/bin/bash
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
tmpdir=$(mktemp -d "${TMPDIR:-/tmp}/dots-pii.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { printf 'ok - %s\n' "$1"; }

printf '%s\n' 'host=node.personal-tailnet.ts.net ip=10.2.3.4 mail=person@private.invalid token=sk-test-0000' |
  bash "$root/scripts/redact.sh" > "$tmpdir/redacted"
grep -q '<redacted:tsnet>' "$tmpdir/redacted" || fail 'redact hostname'
grep -q '<redacted:private-ip>' "$tmpdir/redacted" || fail 'redact private IP'
grep -q '<redacted:email>' "$tmpdir/redacted" || fail 'redact email'
grep -q '<redacted:openai-token>' "$tmpdir/redacted" || fail 'redact token'
pass 'redact positive cases'

safe='docs@example.com 192.0.2.10 <your-host>.<your-tailnet>.ts.net *.ts.net'
actual=$(printf '%s\n' "$safe" | bash "$root/scripts/redact.sh")
[ "$actual" = "$safe" ] || fail 'redact allowlist'
pass 'redact negative cases'

fixture="$root/pii-test-fixture.tmp"
trap 'rm -f "$fixture"; rm -rf "$tmpdir"' EXIT HUP INT TERM
printf '%s\n' 'xoxb-test-0000' > "$fixture"
if bash "$root/scripts/check-pii.sh" > "$tmpdir/check.out"; then fail 'scanner detects token'; fi
grep -q 'pii-test-fixture.tmp:1:slack-token:<redacted:slack-token>' "$tmpdir/check.out" || fail 'scanner masks output'
pass 'scanner positive case'

printf '%s\n' 'safe@example.org 203.0.113.7' > "$fixture"
bash "$root/scripts/check-pii.sh" > "$tmpdir/check-safe.out" || fail 'scanner allowlist'
[ ! -s "$tmpdir/check-safe.out" ] || fail 'scanner safe output'
pass 'scanner negative case'

rm -f "$fixture"
printf '4 tests passed\n'
