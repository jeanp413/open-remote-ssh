#!/usr/bin/env bash
set -euo pipefail

pushd "$( dirname "${BASH_SOURCE[0]}" )" > /dev/null

case "$( uname -s )" in
  MINGW*|MSYS*|CYGWIN*)
    IS_WINDOWS=true
    ;;
  *)
    IS_WINDOWS=false
    ;;
esac

for DIR in ./*; do
  if [[ -d "${DIR}" ]]; then
    DIR="${DIR#./}"

    if [[ "${DIR}" == windows-* && "${IS_WINDOWS}" != true ]] || [[ "${DIR}" != windows-* && "${IS_WINDOWS}" == true ]]; then
      echo "Skipping local-${DIR} for this host platform"
      continue
    fi

    echo "Generating local-${DIR}..."

    docker build -t "local-${DIR}" "${DIR}"
  fi
done

echo "Done"

popd > /dev/null
