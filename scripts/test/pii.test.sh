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

printf '%s\n' 'see docs@example.com or node.personal-tailnet.ts.net' > "$fixture"
if bash "$root/scripts/check-pii.sh" > "$tmpdir/check-mixed.out"; then fail 'allowlisted value must not hide others on the same line'; fi
pass 'scanner mixed line'

line=$(printf '%s\n' 'ip=10.2.3.4 next' | bash "$root/scripts/redact.sh")
[ "$line" = 'ip=<redacted:private-ip> next' ] || fail "redact keeps boundaries: $line"
pass 'redact keeps boundaries'

printf '%s\n' 'NODE.PRIVATE.TS.NET /Users/alice ghp_aaaaaaaaaaaaaaaaaaaaaaaa AKIAAAAAAAAAAAAAAAAA xoxc-1 eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.sig' > "$fixture"
bash "$root/scripts/check-pii.sh" > "$tmpdir/check-more.out" && fail 'extra patterns'
for k in tsnet local-path github-token aws-key slack-token jwt; do
  grep -q ":$k:" "$tmpdir/check-more.out" || fail "extra pattern $k"
done
pass 'scanner extra patterns'

rm -f "$fixture"
# --diff mode: a value added in one commit and removed in the next must still be reported
repo="$tmpdir/repo"
git init -q "$repo"
mkdir -p "$repo/scripts"
cp "$root/scripts/check-pii.sh" "$root/scripts/pii-patterns.txt" "$repo/scripts/"
cp "$root/.pii-allowlist" "$repo/"
(
  cd "$repo"
  git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m base
  printf 'host demo.fake-net.ts.net\n' > leak.txt
  git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m add
  git rm -q leak.txt && git -c user.name=t -c user.email=t@example.com commit -q -m remove
  bash scripts/check-pii.sh > "$tmpdir/wt.out" || exit 11
  bash scripts/check-pii.sh --diff HEAD~2..HEAD > "$tmpdir/diff.out" && exit 12
  grep -q 'leak.txt:[0-9a-f]*:+:tsnet' "$tmpdir/diff.out" || exit 13
) || fail "diff mode (code $?)"
pass 'scanner diff mode catches removed leaks'

printf '8 tests passed\n'
