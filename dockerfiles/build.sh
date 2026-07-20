#!/usr/bin/env bash
set -euo pipefail

pushd "$( dirname "${BASH_SOURCE[0]}" )" > /dev/null

for DIR in ./*; do
  if [[ -d "${DIR}" ]]; then
    DIR="${DIR#./}"

    echo "Generating local-${DIR}..."

    docker build -t "local-${DIR}" "${DIR}"
  fi
done

echo "Done"

popd > /dev/null
