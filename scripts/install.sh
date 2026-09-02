#!/usr/bin/env bash
# Bootstrap for machines with no Node / Node < 18.
# Downloads a private Node 22 into ~/.cursor-agent-traffic-light/runtime, then runs setup.
set -euo pipefail

APP_NAME="cursor-agent-traffic-light"
APP_HOME="${HOME}/.${APP_NAME}"
RUNTIME_DIR="${APP_HOME}/runtime"
NODE_VERSION="22.18.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os_id="darwin" ;;
  Linux) os_id="linux" ;;
  *) echo "Unsupported OS: $os (use install.ps1 on Windows)"; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) cpu="arm64" ;;
  x86_64|amd64) cpu="x64" ;;
  *) echo "Unsupported arch: $arch"; exit 1 ;;
esac

triple="${os_id}-${cpu}"
archive="node-v${NODE_VERSION}-${triple}.tar.gz"
url="https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
prefix="${RUNTIME_DIR}/node-v${NODE_VERSION}-${triple}"
node_bin="${prefix}/bin/node"
bin_dir="$(dirname "${node_bin}")"

mkdir -p "${RUNTIME_DIR}"

if [[ ! -x "${node_bin}" ]]; then
  echo "[install] Downloading Node ${NODE_VERSION} (${triple})…"
  tmp="${RUNTIME_DIR}/${archive}"
  curl -fsSL "${url}" -o "${tmp}"
  tar -xzf "${tmp}" -C "${RUNTIME_DIR}"
  rm -f "${tmp}"
fi

echo "[install] Using ${node_bin}"
cd "${ROOT}"
export PATH="${bin_dir}:${PATH}"

if [[ ! -d node_modules/ws ]]; then
  echo "[install] npm install…"
  if [[ -x "${bin_dir}/npm" ]]; then
    "${bin_dir}/npm" install --omit=dev --no-fund --no-audit
  else
    npm install --omit=dev --no-fund --no-audit
  fi
fi

exec "${node_bin}" "${ROOT}/scripts/setup.mjs" "$@"
