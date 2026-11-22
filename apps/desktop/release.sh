#!/usr/bin/env bash
# Tags main with the newest version in CHANGELOG.md and pushes the tag; .github/workflows/desktop-release.yml builds
# and publishes the release. See README.md.
set -euo pipefail
cd "$(dirname "$0")"
repo=oskarrough/ade

git fetch --quiet origin main
version=$(git show origin/main:apps/desktop/CHANGELOG.md | sed -n 's/^## \([0-9][^ ]*\).*/\1/p' | head -1)
tag="desktop-v$version"

if git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null; then
	echo "$tag is already tagged: add a section for the next version at the top of CHANGELOG.md and push it to main" >&2
	exit 1
fi
git tag "$tag" origin/main
git push --quiet origin "refs/tags/$tag"
echo "Tagged main as $tag; the release builds at https://github.com/$repo/actions/workflows/desktop-release.yml"
