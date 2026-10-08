#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
DOCKERFILES_DIR="${REPO_ROOT}/dockerfiles"
ACTION_FILE="${REPO_ROOT}/.github/actions/build-all-test-images/action.yml"
TEMP_FILE="$(mktemp "${ACTION_FILE}.XXXXXX")"
IMAGE_COUNT=0

trap 'rm -f "${TEMP_FILE}"' EXIT

cat > "${TEMP_FILE}" <<'EOF'
name: Build or restore Docker test images
description: Build or restore the test images for the current runner platform
runs:
  using: composite
  steps:
EOF

for CONTEXT in "${DOCKERFILES_DIR}"/*/; do
  [[ -d "${CONTEXT}" ]] || continue

  IMAGE="${CONTEXT%/}"
  IMAGE="${IMAGE##*/}"

  if [[ ! "${IMAGE}" =~ ^[a-z0-9][a-z0-9._-]*$ ]]; then
    printf 'Unsupported Docker image directory name: %s\n' "${IMAGE}" >&2
    exit 1
  fi

  if [[ "${IMAGE}" == windows-* ]]; then
    PLATFORM='Windows'
  else
    PLATFORM='Linux'
  fi

  cat >> "${TEMP_FILE}" <<EOF
    - name: Build or restore ${IMAGE} image
      if: runner.os == '${PLATFORM}'
      uses: $/.github/actions/build-test-image
      with:
        image: ${IMAGE}
        context: dockerfiles/${IMAGE}
        context-hash: \${{ hashFiles('dockerfiles/${IMAGE}/**') }}
EOF

  IMAGE_COUNT=$((IMAGE_COUNT + 1))
done

if [[ ${IMAGE_COUNT} == 0 ]]; then
  echo "No Docker image directories found in ${DOCKERFILES_DIR}"
  exit 1
fi

mv "${TEMP_FILE}" "${ACTION_FILE}"

trap - EXIT

ACTION_FILE_RELATIVE="${ACTION_FILE#"${REPO_ROOT}/"}"

echo "Generated ${ACTION_FILE_RELATIVE} with ${IMAGE_COUNT} Docker image entries"
