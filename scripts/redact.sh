#!/bin/bash
set -u

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patterns="$script_dir/pii-patterns.txt"
allowlist="$script_dir/../.pii-allowlist"

awk -v allowfile="$allowlist" '
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
    input = $0
    output = ""
    while (length(input)) {
      first = 0
      chosen = 0
      chosen_length = 0
      for (p = 1; p <= np; p++) {
        if (match(input, pattern[p]) && (first == 0 || RSTART < first)) {
          first = RSTART
          chosen = p
          chosen_length = RLENGTH
        }
      }
      if (!chosen) { output = output input; break }
      value = substr(input, first, chosen_length)
      trimmed = value
      sub(/^[^[:alnum:]\/<]/, "", trimmed)
      sub(/[^[:alnum:]_.>@\/-]$/, "", trimmed)
      permitted = 0
      for (a = 1; a <= na; a++) if (trimmed ~ allow[a]) permitted = 1
      # keep boundary characters consumed by the pattern (e.g. "=" before an IP)
      lead = ""; tail = ""
      if (match(value, /^[^[:alnum:]\/<]/)) lead = substr(value, 1, 1)
      if (match(value, /[^[:alnum:]_.>@\/-]$/)) tail = substr(value, length(value), 1)
      output = output substr(input, 1, first - 1)
      if (permitted) output = output value
      else output = output lead "<redacted:" kind[chosen] ">" tail
      input = substr(input, first + chosen_length)
    }
    print output
  }
' "$patterns" -
