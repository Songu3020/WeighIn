#!/usr/bin/env bash

set -euo pipefail

CONTAINER_NAME="stellar-quickstart"
IMAGE="stellar/quickstart@sha256:4c8bad1ef7341205b898f83d9489321da80c7bd74183100fc8e2a39a5938c7d5"
OWNER_LABEL="io.weighin.managed-by"
OWNER_VALUE="weighin-start-local-network"
PORT=8000
RPC_URL="http://localhost:${PORT}/rpc"

# The CI builds TypeScript and installs Node dependencies before this script.
node -e "require('./dist/account'); require('@stellar/stellar-sdk')"

echo "Checking if container '${CONTAINER_NAME}' is already running..."
existing_container="$(docker ps -a -q -f "name=^/${CONTAINER_NAME}$")"
if [ -n "${existing_container}" ]; then
    if ! owner="$(docker inspect --format "{{ index .Config.Labels \"${OWNER_LABEL}\" }}" "${CONTAINER_NAME}")"; then
        echo "Error: Could not verify ownership of '${CONTAINER_NAME}'; leaving it untouched." >&2
        exit 1
    fi

    if [ "${owner}" != "${OWNER_VALUE}" ] && [ "${WEIGHIN_REPLACE_UNOWNED_CONTAINER:-}" != "1" ]; then
        echo "Error: Container '${CONTAINER_NAME}' is not owned by this startup script and was left untouched." >&2
        echo "Set WEIGHIN_REPLACE_UNOWNED_CONTAINER=1 to explicitly authorize replacing it." >&2
        exit 1
    fi

    if [ "${owner}" = "${OWNER_VALUE}" ]; then
        echo "Removing owned container '${CONTAINER_NAME}'..."
    else
        echo "Explicit replacement authorized; removing '${CONTAINER_NAME}'..."
    fi
    docker rm -f "${CONTAINER_NAME}"
fi

# Until readiness is confirmed, any exit stops the container this attempt
# started, addressed by its ID so no other container is ever touched. Logs are
# captured first because the --rm container is deleted once it stops. A failed
# cleanup is reported but never turns the failed start into success. The traps
# are installed before docker run so a signal received while it starts the
# container is handled once its ID is known.
ready=0
container_id=""
cleanup_unready_sidecar() {
    local status=$?
    trap - EXIT INT TERM
    if [ "${ready}" = "1" ]; then
        exit "${status}"
    fi
    if [ -z "${container_id}" ]; then
        if [ "${status}" -eq 0 ]; then
            status=1
        fi
        exit "${status}"
    fi
    echo "Capturing logs from container ${container_id} before stopping it..." >&2
    docker logs "${container_id}" || echo "Warning: could not capture logs from container ${container_id}." >&2
    if ! docker stop "${container_id}" >/dev/null; then
        echo "Warning: could not stop container ${container_id}; remove it with: docker rm -f ${container_id}" >&2
    fi
    if [ "${status}" -eq 0 ]; then
        status=1
    fi
    exit "${status}"
}
trap cleanup_unready_sidecar EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting ${IMAGE} in local standalone mode..."
container_id="$(docker run --rm -d \
  --name "${CONTAINER_NAME}" \
    --label "${OWNER_LABEL}=${OWNER_VALUE}" \
  -p "${PORT}:8000" \
  ${IMAGE} --local)"
if [ -z "${container_id}" ]; then
    echo "Error: docker run did not report the new container ID, so it cannot be cleaned up safely." >&2
    exit 1
fi

echo "Waiting for RPC health, Friendbot funding and RPC account inclusion at ${RPC_URL}..."
if node "$(dirname "$0")/wait-for-local-network.cjs" "${RPC_URL}"; then
    ready=1
    exit 0
fi

echo "Error: Stellar Quickstart account/network readiness failed." >&2
exit 1
