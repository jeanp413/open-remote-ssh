#!/bin/sh
set -u

OUTPUT_FILE="$(mktemp)" || exit 1
trap 'rm -f "$OUTPUT_FILE"' EXIT HUP INT TERM

export NATIVE_SSH_ASKPASS_FILE="$OUTPUT_FILE"
"${NATIVE_SSH_NODE_BIN:?NATIVE_SSH_NODE_BIN is required}" \
  "${NATIVE_SSH_ASKPASS_NODE_SCRIPT:?NATIVE_SSH_ASKPASS_NODE_SCRIPT is required}" \
  "$@"
status=$?

if [ "$status" -eq 0 ]; then
  cat "$OUTPUT_FILE"
fi

exit "$status"
