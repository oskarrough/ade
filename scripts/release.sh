#!/usr/bin/env bash
# Cuts a release of ade: tags origin's main as the next v<major>.<minor>.<patch>, with the subjects of the commits since
# the previous release as its message, and pushes the tag. Installed houses, arbe desktop's and npx's, update only to
# these. `pnpm release` takes the next patch; `pnpm release 0.3.0` names the version.
set -euo pipefail
cd "$(dirname "$0")/.."

git fetch --quiet --tags origin main
previous=$(git tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1 || true)
if [ -n "${1:-}" ]; then
	version="${1#v}"
elif [ -n "$previous" ]; then
	IFS=. read -r major minor patch <<< "${previous#v}"
	version="$major.$minor.$((patch + 1))"
else
	version=$(node -p 'require("./package.json").version')
fi
tag="v$version"

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
	echo "$version isn't a version like 0.2.0" >&2
	exit 1
}
if git ls-remote --exit-code --tags origin "refs/tags/$tag" > /dev/null; then
	echo "$tag is already a release" >&2
	exit 1
fi
if [ -n "$previous" ]; then
	notes=$(git log --format=%s "$previous..origin/main")
	[ -n "$notes" ] || {
		echo "main hasn't changed since $previous" >&2
		exit 1
	}
else
	notes=$(git log --format=%s -n 20 origin/main)
fi

git tag --annotate --cleanup=verbatim --message "$notes" "$tag" origin/main
git push --quiet origin "refs/tags/$tag"
echo "Released main as $tag, with $(printf '%s\n' "$notes" | wc -l | tr -d ' ') changes since ${previous:-the start}"
