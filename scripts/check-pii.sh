#!/bin/bash
# Scan for personal information / secrets.
#   check-pii.sh               scan tracked + untracked (not ignored) files in the working tree
#   check-pii.sh --diff RANGE  scan every line added by every commit in RANGE (e.g. origin/main..HEAD),
#                              so PII added and later removed inside a PR is still caught
set -u

root=$(git rev-parse --show-toplevel) || exit 2
patterns="$root/scripts/pii-patterns.txt"
allowlist="$root/.pii-allowlist"
cd "$root" || exit 2

# awk program shared by both modes. Input lines are "<source>\t<line>\t<text>".
scan() {
  awk -F '\t' -v patfile="$patterns" -v allowfile="$allowlist" '
    BEGIN {
      while ((getline row < patfile) > 0) {
        tab = index(row, "\t")
        if (tab > 1) { kind[++np] = substr(row, 1, tab - 1); pattern[np] = substr(row, tab + 1) }
      }
      close(patfile)
      while ((getline row < allowfile) > 0) {
        if (row ~ /^path:/) skip[++ns] = substr(row, 6)
        else if (row !~ /^(#|[[:space:]]*$)/) allow[++na] = row
      }
      close(allowfile)
    }
    {
      source = $1; lineno = $2
      text = substr($0, length($1) + length($2) + 3)
      skipped = 0
      for (s = 1; s <= ns; s++) if (source ~ skip[s]) skipped = 1
      if (skipped) next
      for (p = 1; p <= np; p++) {
        rest = text
        while (match(rest, pattern[p])) {
          value = substr(rest, RSTART, RLENGTH)
          trimmed = value
          sub(/^[^[:alnum:]\/<]/, "", trimmed)
          sub(/[^[:alnum:]_.>@\/-]$/, "", trimmed)
          permitted = 0
          for (a = 1; a <= na; a++) if (trimmed ~ allow[a]) permitted = 1
          if (!permitted) { printf "%s:%s:%s:<redacted:%s>\n", source, lineno, kind[p], kind[p]; bad = 1 }
          rest = substr(rest, RSTART + RLENGTH)
          if (RLENGTH == 0) break
        }
      }
    }
    END { exit bad ? 1 : 0 }
  '
}

if [ "${1:-}" = "--diff" ]; then
  range=${2:?usage: check-pii.sh --diff <range>}
  # emit "<commit>:<path>\t+\t<added line>" for every added line of every commit
  git log -p --no-color --no-ext-diff --format='@@commit %h' "$range" -- |
    awk '
      /^@@commit / { commit = $2; next }
      /^\+\+\+ / { path = substr($0, 5); sub(/^b\//, "", path); next }
      /^\+/ { printf "%s\t%s:%s\t%s\n", path, commit, "+", substr($0, 2) }
    ' | scan
  exit $?
fi

status=0
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  grep -Iq . "$file" || continue
  awk -v f="$file" '{ printf "%s\t%d\t%s\n", f, FNR, $0 }' "$file" | scan || status=1
done < <(git ls-files -z --cached --others --exclude-standard)

exit "$status"
