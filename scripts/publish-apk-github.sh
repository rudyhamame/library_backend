#!/usr/bin/env bash
set -euo pipefail

apk_path="${1:-}"
repository="${GITHUB_REPOSITORY:-rudyhamame/stream_front}"
release_tag="${GITHUB_RELEASE_TAG:-android-latest}"
asset_name="${ANDROID_APP_ASSET_NAME:-RH-IPTV-Library.apk}"

if [[ -z "$apk_path" || ! -f "$apk_path" ]]; then
  echo "Usage: $0 <debug-apk-path>" >&2
  exit 1
fi
if [[ "$(basename "$apk_path")" != "app-debug.apk" ]]; then
  echo "Only app-debug.apk may be published by this task" >&2
  exit 1
fi
command -v gh >/dev/null 2>&1 || { echo "GitHub CLI (gh) is required" >&2; exit 1; }

staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT
staged_apk="$staging_dir/$asset_name"
cp "$apk_path" "$staged_apk"

if gh release view "$release_tag" --repo "$repository" >/dev/null 2>&1; then
  gh release delete-asset "$release_tag" app-debug.apk --repo "$repository" --yes >/dev/null 2>&1 || true
  gh release delete-asset "$release_tag" RH.IPTV.Library.apk --repo "$repository" --yes >/dev/null 2>&1 || true
  gh release upload "$release_tag" "$staged_apk" --repo "$repository" --clobber
else
  gh release create "$release_tag" "$staged_apk" --repo "$repository" --title "RH IPTV Library" --notes "Latest RH IPTV Library Android debug build."
fi
echo "Published $asset_name to https://github.com/$repository/releases/latest/download/$asset_name"
