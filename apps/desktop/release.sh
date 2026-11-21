#!/usr/bin/env bash
# Builds arbe desktop for Windows and Linux, signs its updates, uploads them to the GitHub release of the newest
# version in CHANGELOG.md and publishes it, without making it the repository's latest release. See README.md.
set -euo pipefail
cd "$(dirname "$0")"

version=$(sed -n 's/^## \([0-9][^ ]*\).*/\1/p' CHANGELOG.md | head -1)
tag="desktop-v$version"
repo=oskarrough/ade
key="${MYGO_UPDATER_KEY_FILE:-$HOME/.config/mygo/update-keys/mygo-update.key}"

if gh release view "$tag" --repo "$repo" > /dev/null 2>&1 && [ "$(gh release view "$tag" --repo "$repo" --json isDraft -q .isDraft)" = false ]; then
	echo "$tag is already out: add a section for the next version at the top of CHANGELOG.md" >&2
	exit 1
fi
if [ -z "${MYGO_UPDATER_PRIVATE_KEY:-}" ]; then
	[ -r "$key" ] || { echo "No update key at $key; restore it from the password manager (README.md)" >&2; exit 1; }
	MYGO_UPDATER_PRIVATE_KEY="$(cat "$key")"
	export MYGO_UPDATER_PRIVATE_KEY
fi

# go.mod names the Go that MyGo needs; let go fetch it when the system's is older
GOTOOLCHAIN=auto go tool mygo build -platform windows/amd64,linux/amd64 -upload
gh release edit "$tag" --repo "$repo" --draft=false --latest=false
echo "Published $tag: https://github.com/$repo/releases/tag/$tag"
