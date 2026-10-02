#!/bin/bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
tmpdir=$(mktemp -d "$root/.pii-tests.local.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT
tests=0
fail() { printf 'not ok - %s\n' "$1" >&2; exit 1; }
pass() { tests=$((tests + 1)); printf 'ok - %s\n' "$1"; }

# Assemble synthetic positive cases so source code contains no private-looking literals.
host=$(printf '%s.%s.%s' node fixture-network ts.net)
ip=$(printf '%s.%s.%s.%s' 10 2 3 4)
mail=$(printf '%s@%s' fixture private.invalid)
token=$(printf '%s%s' sk- fixture-positive)
slack=$(printf '%s%s' xoxb- fixture-positive)
printf 'host=%s ip=%s mail=%s token=%s\n' "$host" "$ip" "$mail" "$token" |
  bash "$root/scripts/redact.sh" > "$tmpdir/redacted"
for kind in tsnet private-ip email openai-token; do
  grep -q "<redacted:$kind>" "$tmpdir/redacted" || fail "redact $kind"
done
pass 'redact positive cases'

safe='docs@example.com 192.0.2.10 <your-host>.<your-tailnet>.ts.net *.ts.net fixture.fake-tailnet.ts.net sk-test-fixture'
actual=$(printf '%s\n' "$safe" | bash "$root/scripts/redact.sh")
[ "$actual" = "$safe" ] || fail 'redact allowlist'
pass 'redact exact synthetic values and placeholders'

line=$(printf 'ip=%s next\n' "$ip" | bash "$root/scripts/redact.sh")
[ "$line" = 'ip=<redacted:private-ip> next' ] || fail 'redact keeps boundaries'
pass 'redact keeps boundaries'

# All scanner tests run in an isolated repository inside the ignored scratch directory.
repo="$tmpdir/repo"
git init -q "$repo"
mkdir -p "$repo/scripts/test"
cp "$root/scripts/check-pii.sh" "$root/scripts/redact.sh" "$root/scripts/pii-patterns.txt" "$repo/scripts/"
cp "$root/scripts/test/pii.test.sh" "$repo/scripts/test/"
cp "$root/.pii-allowlist" "$root/.gitignore" "$repo/"
cd "$repo"
commit() { git -c user.name=fixture -c user.email=fixture@example.com commit -q "$@"; }
check_safe() {
  bash scripts/check-pii.sh > "$tmpdir/check.out" || fail "$1"
  [ ! -s "$tmpdir/check.out" ] || fail "$1 output"
}
check_bad() {
  if bash scripts/check-pii.sh > "$tmpdir/check.out"; then fail "$1"; fi
  grep -q ":$2:<redacted:$2>" "$tmpdir/check.out" || fail "$1 diagnostic"
}
check_safe 'scanner includes its own source and synthetic fixture values'
pass 'scanner includes its own source and synthetic fixture values'
git add -A
commit -m base

fixture='fixture with spaces.tmp'
printf '%s\n' "$slack" > "$fixture"
check_bad 'scanner detects token' slack-token
grep -q '^fixture with spaces.tmp:1:slack-token:' "$tmpdir/check.out" || fail 'scanner location'
if grep -Fq "$slack" "$tmpdir/check.out"; then fail 'scanner masks output'; fi
pass 'scanner detects tokens with redacted output and spaced paths'

printf '%s\n' 'safe@example.org 203.0.113.7' > "$fixture"
check_safe 'scanner allowlist'
pass 'scanner negative case'

printf 'see docs@example.com or %s\n' "$host" > "$fixture"
check_bad 'allowlisted value must not hide others on the same line' tsnet
pass 'scanner mixed line'

upper_host=$(printf '%s' "$host" | tr '[:lower:]' '[:upper:]')
printf '%s %s%s %s%s %s%s %s%s %s.%s.%s\n' "$upper_host" /home/ fixture \
  ghp_ aaaaaaaaaaaaaaaaaaaaaaaa AKIA AAAAAAAAAAAAAAAA xoxc- fixture \
  eyJhbGciOiJub25lIn0 eyJzdWIiOiJ4In0 sig > "$fixture"
check_bad 'extra patterns' tsnet
for kind in local-path github-token aws-key slack-token jwt; do
  grep -q ":$kind:" "$tmpdir/check.out" || fail "extra pattern $kind"
done
pass 'scanner extra patterns'
rm "$fixture"

for source in scripts/check-pii.sh scripts/redact.sh scripts/test/pii.test.sh scripts/pii-patterns.txt; do
  cp "$source" "$tmpdir/source"
  printf '\n# host=%s\n' "$host" >> "$source"
  printf '  # comment\thost=%s\n' "$host" >> "$source"
  check_bad "scanner detects comments in $source" tsnet
  grep -q "^$source:" "$tmpdir/check.out" || fail 'scanner comment location'
  [ "$(grep -c ':tsnet:' "$tmpdir/check.out")" -eq 2 ] || fail 'tabbed comments are not pattern definitions'
  cp "$tmpdir/source" "$source"
  pass "scanner detects comments in $source"
done

printf '%s.%s\n' prefix fixture.fake-tailnet.ts.net > "$fixture"
check_bad 'synthetic hostname permission is exact' tsnet
printf '%s%s\n' sk-test-fixture suffix > "$fixture"
check_bad 'synthetic token permission is exact' openai-token
pass 'synthetic permissions do not allow longer values'

for encoding in UTF-16LE UTF-16BE; do
  # BOM makes the byte order explicit for file(1) on both macOS and Linux.
  printf '\357\273\277host=%s\n' "$host" | iconv -f UTF-8 -t "$encoding" > "$fixture"
  check_bad "$encoding detects hostname" tsnet
  if grep -Fq "$host" "$tmpdir/check.out"; then fail 'UTF-16 output redaction'; fi
  printf '\357\273\277safe@example.com 192.0.2.10\n' | iconv -f UTF-8 -t "$encoding" > "$fixture"
  check_safe "$encoding safe text"
  pass "scanner converts $encoding and checks values"
done

printf '\377\376h\000o' > "$fixture"
check_bad 'malformed UTF-16 fails closed' encoding-error
pass 'malformed UTF-16 fails closed'

printf 'host=%s\000suffix\n' "$host" > "$fixture"
check_bad 'NUL-containing text cannot bypass inspection' unapproved-binary
pass 'NUL-containing text fails closed'

printf '\211PNG\r\n\032\n\000fixture' > "$fixture"
check_bad 'unapproved image' unapproved-binary
digest=$(shasum -a 256 "$fixture"); digest=${digest%% *}
printf 'binary:%s:%s\n' "$digest" "$fixture" >> .pii-allowlist
check_safe 'reviewed binary'
cp "$fixture" other-image.tmp
check_bad 'binary approval is path-specific' unapproved-binary
rm other-image.tmp
printf 'changed' >> "$fixture"
check_bad 'binary approval is byte-specific' unapproved-binary
pass 'binary permissions require exact path and SHA-256 bytes'
rm "$fixture"
git restore .pii-allowlist

printf '' > "$fixture"
check_safe 'empty file'
pass 'empty files pass'
rm "$fixture"

# Capture leaks in history even when removed, renamed, or introduced in a merge.
for mode in text UTF-16LE UTF-16BE binary; do
  base=$(git rev-parse HEAD)
  case "$mode" in
    text) printf 'host=%s\n' "$host" > "$fixture"; kind=tsnet ;;
    binary) printf '\000binary fixture\000' > "$fixture"; kind=unapproved-binary ;;
    *) printf '\357\273\277host=%s\n' "$host" | iconv -f UTF-8 -t "$mode" > "$fixture"; kind=tsnet ;;
  esac
  git add "$fixture"; commit -m add
  git mv "$fixture" 'renamed fixture.tmp'; commit -m rename
  git rm -q 'renamed fixture.tmp'; commit -m remove
  check_safe 'removed fixture is absent in working tree'
  if bash scripts/check-pii.sh --diff "$base..HEAD" > "$tmpdir/diff.out"; then fail "$mode history"; fi
  grep -q "^fixture with spaces.tmp:[0-9a-f]*:[0-9]*:$kind:" "$tmpdir/diff.out" || fail "$mode history location"
  grep -q "^renamed fixture.tmp:[0-9a-f]*:[0-9]*:$kind:" "$tmpdir/diff.out" || fail "$mode rename history"
  if grep -Fq "$host" "$tmpdir/diff.out"; then fail 'history masks output'; fi
  pass "diff mode catches removed and renamed $mode fixtures"
done

base=$(git rev-parse HEAD)
git checkout -qb side
printf 'safe\n' > side.txt
git add side.txt; commit -m side
git checkout -qb main-fixture "$base"
printf 'safe\n' > main.txt
git add main.txt; commit -m main
git -c user.name=fixture -c user.email=fixture@example.com merge -q --no-commit side
printf 'host=%s\n' "$host" > "$fixture"
git add "$fixture"; commit -m merge
if bash scripts/check-pii.sh --diff "$base..HEAD" > "$tmpdir/diff.out"; then fail 'merge history'; fi
grep -q ':tsnet:' "$tmpdir/diff.out" || fail 'merge diagnostic'
pass 'diff mode checks merge-introduced content'

if bash scripts/check-pii.sh --diff missing-ref..HEAD > "$tmpdir/invalid.out" 2>/dev/null; then fail 'invalid range'; fi
pass 'invalid ranges fail'
printf '%d tests passed\n' "$tests"
