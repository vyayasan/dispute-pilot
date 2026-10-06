#!/bin/sh
set -eu
cd "$(dirname "$0")"
for name in system-architecture dispute-lifecycle approval-binding kit4-and-mandate; do
  dot -Tsvg "$name.dot" -o "$name.svg"
  dot -Tpng -Gdpi=160 "$name.dot" -o "$name.png"
done
