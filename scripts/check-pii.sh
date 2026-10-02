#!/bin/bash
# Scan for personal information / secrets.
#   check-pii.sh               scan tracked + untracked (not ignored) files in the working tree
#   check-pii.sh --diff RANGE  scan changed file snapshots in every commit in RANGE,
#                              including encoded/binary files later removed inside a PR
set -euo pipefail

root=$(git rev-parse --show-toplevel) || exit 2
patterns="$root/scripts/pii-patterns.txt"
allowlist="$root/.pii-allowlist"
cd "$root" || exit 2

# Only pattern-definition lines are exempt; comments in the pattern file are scanned.
scan() {
  awk -v source="$2" -v revision="${3:-}" -v patfile="$patterns" -v allowfile="$allowlist" '
    BEGIN {
      while ((getline row < patfile) > 0) {
        tab = index(row, "\t")
        if (tab > 1 && substr(row, 1, tab - 1) ~ /^[a-z][a-z-]*$/) {
          kind[++np] = substr(row, 1, tab - 1); pattern[np] = substr(row, tab + 1)
          definition[row] = 1
        }
      }
      close(patfile)
      while ((getline row < allowfile) > 0) {
        if (row !~ /^(#|[[:space:]]*$|binary:)/) allow[++na] = row
      }
      close(allowfile)
    }
    {
      text = $0
      if (source == "scripts/pii-patterns.txt" && text in definition) next
      for (p = 1; p <= np; p++) {
        rest = text
        while (match(rest, pattern[p])) {
          value = substr(rest, RSTART, RLENGTH)
          trimmed = value
          sub(/^[^[:alnum:]\/<]/, "", trimmed)
          sub(/[^[:alnum:]_.>@\/-]$/, "", trimmed)
          permitted = 0
          for (a = 1; a <= na; a++) if (trimmed ~ allow[a]) permitted = 1
          if (!permitted) { printf "%s:%s%d:%s:<redacted:%s>\n", source, revision, FNR, kind[p], kind[p]; bad = 1 }
          rest = substr(rest, RSTART + RLENGTH)
          if (RLENGTH == 0) break
        }
      }
    }
    END { exit bad ? 1 : 0 }
  ' "$1"
}

tmpdir=$(mktemp -d "$root/.pii-scan.local.XXXXXX")
trap 'rm -rf "$tmpdir"' EXIT

diagnostic() {
  printf '%s:%s0:%s:<redacted:%s>\n' "$2" "${3:-}" "$1" "$1"
}

scan_file() {
  local input=$1 source=$2 revision=${3:-} encoding digest
  # file(1) reports an empty file as binary; there are no bytes to inspect.
  [ -s "$input" ] || return 0
  if ! encoding=$(file --brief --mime-encoding -- "$input" 2>/dev/null); then
    diagnostic encoding-error "$source" "$revision"; return 1
  fi
  case "$encoding" in
    utf-16*)
      if ! iconv -f "$encoding" -t UTF-8 "$input" > "$tmpdir/decoded" 2>/dev/null; then
        diagnostic encoding-error "$source" "$revision"; return 1
      fi
      scan "$tmpdir/decoded" "$source" "$revision"
      ;;
    binary)
      digest=$(shasum -a 256 -- "$input") || return 1
      digest=${digest%% *}
      if ! grep -Fxq -- "binary:$digest:$source" "$allowlist"; then
        diagnostic unapproved-binary "$source" "$revision"; return 1
      fi
      ;;
    *) scan "$input" "$source" "$revision" ;;
  esac
}

status=0
if [ "${1:-}" = "--diff" ]; then
  range=${2:?usage: check-pii.sh --diff <range>}
  # Read Git blobs rather than patches: Git may omit binary/UTF-16 content entirely.
  git rev-list "$range" > "$tmpdir/commits"
  while IFS= read -r commit; do
    git diff-tree --root -m -r --no-renames --no-commit-id --name-only -z --diff-filter=ACMT "$commit" > "$tmpdir/paths"
    while IFS= read -r -d '' path; do
      git cat-file blob "$commit:$path" > "$tmpdir/blob"
      scan_file "$tmpdir/blob" "$path" "${commit:0:12}:" || status=1
    done < "$tmpdir/paths"
  done < "$tmpdir/commits"
  exit "$status"
elif [ "$#" -ne 0 ]; then
  printf 'usage: check-pii.sh [--diff <range>]\n' >&2
  exit 2
fi

git ls-files -z --cached --others --exclude-standard > "$tmpdir/paths"
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  scan_file "$file" "$file" || status=1
done < "$tmpdir/paths"

exit "$status"
