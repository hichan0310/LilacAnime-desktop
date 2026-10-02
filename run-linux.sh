#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -x node_modules/electron/dist/electron ]]; then
  printf '먼저 npm ci를 실행해 주세요.\n' >&2
  exit 1
fi
node scripts/build-jassub.cjs
exec env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron . "$@"
