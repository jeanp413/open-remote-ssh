#!/usr/bin/env bash

set -e

# git workaround
if [[ "${CI_BUILD}" != "no" ]]; then
  git config --global --add safe.directory "/__w/$( echo "${GITHUB_REPOSITORY}" | awk '{print tolower($0)}' )"
fi

if [[ -n "${PULL_REQUEST_ID}" ]]; then
  BRANCH_NAME=$( git rev-parse --abbrev-ref HEAD )

  git config --global user.email "$( echo "${GITHUB_USERNAME}" | awk '{print tolower($0)}' )-ci@not-real.com"
  git config --global user.name "${GITHUB_USERNAME} CI"
  git fetch --unshallow || true
  git fetch origin "pull/${PULL_REQUEST_ID}/head"

  PR_TREE=$( git rev-parse 'FETCH_HEAD^{tree}' )

  if git log --format=%T "origin/${BRANCH_NAME}" | grep --quiet --fixed-strings "${PR_TREE}"; then
    git checkout "origin/${BRANCH_NAME}"
  else
    git checkout FETCH_HEAD
    git merge --no-edit "origin/${BRANCH_NAME}"
  fi
fi
