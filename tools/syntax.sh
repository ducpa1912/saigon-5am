#!/bin/zsh
# ES-module syntax gate. `node --check` treats bare .js as CommonJS and reports
# false failures on every `import`/`export`, so mirror each file to .mjs first.
cd "$(dirname "$0")/.." || exit 1
mkdir -p .cache/syntax
rm -f .cache/syntax/*.mjs 2>/dev/null
fail=0
for f in js/*.js; do
  b=$(basename "$f" .js)
  cp "$f" ".cache/syntax/$b.mjs"
  out=$(node --check ".cache/syntax/$b.mjs" 2>&1)
  if [ -n "$out" ]; then
    echo "FAIL $f"
    echo "$out" | grep -E "Error" | head -3
    fail=1
  else
    echo "ok   $f"
  fi
done
rm -f .cache/syntax/*.mjs 2>/dev/null
if [ "$fail" = "1" ]; then echo "SYNTAX FAILURES"; exit 1; fi
echo "all modules parse"