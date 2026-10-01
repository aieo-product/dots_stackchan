#!/bin/bash
set -u

root=$(git rev-parse --show-toplevel) || exit 2
patterns="$root/scripts/pii-patterns.txt"
allowlist="$root/.pii-allowlist"
status=0

cd "$root" || exit 2
while IFS= read -r -d '' file; do
  skip=0
  while IFS= read -r rule || [ -n "$rule" ]; do
    case "$rule" in
      path:*) printf '%s\n' "$file" | grep -Eq "${rule#path:}" && skip=1 ;;
    esac
  done < "$allowlist"
  [ "$skip" -eq 1 ] && continue
  [ -f "$file" ] || continue
  grep -Iq . "$file" || continue

  awk -v source="$file" -v allowfile="$allowlist" '
    BEGIN {
      while ((getline row < allowfile) > 0) {
        if (row !~ /^(#|[[:space:]]*$|path:)/) allow[++na] = row
      }
      close(allowfile)
    }
    FNR == NR {
      tab = index($0, "\t")
      if (tab > 1) {
        kind[++np] = substr($0, 1, tab - 1)
        pattern[np] = substr($0, tab + 1)
      }
      next
    }
    {
      line = $0
      for (p = 1; p <= np; p++) {
        rest = line
        while (match(rest, pattern[p])) {
          value = substr(rest, RSTART, RLENGTH)
          trimmed = value
          sub(/^[^[:alnum:]\/<]/, "", trimmed)
          sub(/[^[:alnum:]_.>@\/-]$/, "", trimmed)
          permitted = 0
          for (a = 1; a <= na; a++) {
            if (trimmed ~ allow[a]) permitted = 1
          }
          if (!permitted) {
            printf "%s:%d:%s:<redacted:%s>\n", source, FNR, kind[p], kind[p]
            bad = 1
          }
          rest = substr(rest, RSTART + RLENGTH)
          if (RLENGTH == 0) break
        }
      }
    }
    END { exit bad ? 1 : 0 }
  ' "$patterns" "$file" || status=1
done < <(git ls-files -z --cached --others --exclude-standard)

exit "$status"
