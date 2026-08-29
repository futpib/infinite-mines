#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_name="${INFINITE_MINES_CI_IMAGE:-infinite-mines-ci:playwright-1.62.1-node-22.23.2}"

if [[ "${1:-}" != "--skip-build" ]]; then
  docker build \
    --pull \
    --network host \
    --platform linux/amd64 \
    --file "${repo_root}/Dockerfile.ci" \
    --tag "${image_name}" \
    "${repo_root}"
fi

mkdir -p "${repo_root}/playwright-report" "${repo_root}/test-results"

docker run \
  --rm \
  --init \
  --ipc=host \
  --network none \
  --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  --env CI=1 \
  --env HOME=/tmp \
  --env TZ=UTC \
  --volume "${repo_root}/playwright-report:/workspace/playwright-report" \
  --volume "${repo_root}/test-results:/workspace/test-results" \
  "${image_name}"
