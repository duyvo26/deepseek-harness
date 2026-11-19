#!/usr/bin/env bash
# Build "DeepSeek Harness DEV" for this Mac and open the output in Finder.
#
# The build is unsigned: no Developer ID, no notarization, no Apple ID. macOS will
# ask for a security confirmation the first time the app opens.
#
# The built app shares the chat history in the DSH home (default ~/.dsh) with any
# installed release, but keeps its own Electron profile directory because its
# product name carries the DEV suffix.

set -euo pipefail

# The workspace is already installed; a script run must not try to reconcile
# node_modules, which needs a TTY this launcher does not provide.
export CI="${CI:-true}"
export verifyDepsBeforeRun="${verifyDepsBeforeRun:-false}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$REPO_ROOT"

PNPM_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
if [[ -x "$(command -v pnpm)" ]]; then
  PNPM=(pnpm)
elif [[ -f "$PNPM_BIN" ]]; then
  PNPM=(node "$PNPM_BIN")
else
  echo "error: pnpm not found on PATH and not present at $PNPM_BIN" >&2
  exit 1
fi

TARGET="mac-arm64"
SCRIPT_NAME="package:mac:arm64:unsigned"
if [[ "$(uname -m)" == "x86_64" ]]; then
  TARGET="mac-x64"
  SCRIPT_NAME="package:mac:x64:unsigned"
fi

echo "==> Building DeepSeek Harness DEV ($TARGET, unsigned)"
echo "    This takes several minutes and downloads Electron on the first run."

# One build produces the runtime tree, the client bundles and the Web shell the
# packaged app loads, so the packaging step below consumes current artifacts.
"${PNPM[@]}" run build:artifacts

# The packaging script resolves its own workspace through pnpm, so it runs from
# the desktop package directory rather than through a root-level filter.
(
  cd "$REPO_ROOT/apps/desktop"
  "${PNPM[@]}" run "$SCRIPT_NAME"
)

OUT_DIR="$REPO_ROOT/apps/desktop/.desktop-build/targets/$TARGET/unsigned-artifacts"
if [[ ! -d "$OUT_DIR" ]]; then
  echo "error: expected build output at $OUT_DIR, but it is missing" >&2
  exit 1
fi

echo
echo "==> Output: $OUT_DIR"
ls -lh "$OUT_DIR" | sed '1d' | awk '{ print "    " $9 "  " $5 }'

APP_BUNDLE="$OUT_DIR/mac-arm64/DeepSeek Harness DEV.app"
if [[ "$TARGET" == "mac-x64" ]]; then
  APP_BUNDLE="$OUT_DIR/mac/DeepSeek Harness DEV.app"
fi

if [[ -d "$APP_BUNDLE" ]]; then
  echo
  echo "==> App bundle: $APP_BUNDLE"
fi

open "$OUT_DIR"
echo
echo "Done. Open the DMG and drag \"DeepSeek Harness DEV\" into Applications."
