#!/bin/sh
# Fetch the frontend release zip into the build context.
#
# The backend image bundles a prebuilt frontend rather than compiling one. This
# goes through `gh` rather than a bare curl so it keeps working if the frontend
# repo is ever made private again: private release assets are only reachable
# through the API asset endpoint, not the /releases/latest/download/ redirect.
#
# Usage: ./scripts/fetch-frontend.sh [tag]     (default: latest release)

set -eu

REPO="${FRONTEND_REPO:-mikyllyn/remnawave-frontend}"
TAG="${1:-}"
OUT="frontend.zip"

cd "$(dirname "$0")/.."

if ! command -v gh >/dev/null 2>&1; then
    echo "error: gh CLI not found — install it or download $OUT manually" >&2
    exit 1
fi

if [ -n "$TAG" ]; then
    echo "Fetching remnawave-frontend.zip from $REPO@$TAG"
    gh release download "$TAG" --repo "$REPO" --pattern 'remnawave-frontend.zip' --output "$OUT" --clobber
else
    echo "Fetching remnawave-frontend.zip from the latest release of $REPO"
    gh release download --repo "$REPO" --pattern 'remnawave-frontend.zip' --output "$OUT" --clobber
fi

echo "Wrote $OUT ($(wc -c < "$OUT") bytes)"
