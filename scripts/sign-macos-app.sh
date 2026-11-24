#!/bin/sh
set -eu

APP_PATH="$(dirname "$0")/../target/release/bundle/macos/Meeting Notes.app"
BUNDLE_ID="com.local.meeting-notes"

if [ ! -d "$APP_PATH" ]; then
  echo "Missing macOS app bundle: $APP_PATH" >&2
  exit 1
fi

# Ad-hoc signing normally identifies each rebuilt executable by its cdhash.
# Embed a stable designated requirement so macOS TCC recognizes new builds as
# the same local app and preserves Screen Capture and Microphone approvals.
codesign --force --deep --sign - \
  --identifier "$BUNDLE_ID" \
  --requirements "=designated => identifier \"$BUNDLE_ID\"" \
  "$APP_PATH"
