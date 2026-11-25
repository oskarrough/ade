# arbe desktop's house: starts, updates or tells the state of the ade server and runner it started, in a login shell
# on the machine (inside WSL on Windows). main.go puts HOUSE_DIR, HOUSE_COMMAND and HOUSE_SCRIPT, this script's own
# text, above it. The first line it prints is "<WSL distro>:<log file>", the last the state: running, stopped,
# started, installing or updating; for key, the owner key.
# It keeps the process group and a token in the pid file; stop it with kill -TERM -- -<pid>, the pid file's first word.
# Without ade installed, it keeps its own: ade's newest release from GitHub in $own/ade, and Node from nodejs.org in
# $own/node when the shell has no Node 24 or newer. update stages a newer release in $own/ade.next, never main; the
# page then offers Update, and the server's restart, or the next start here, takes it up. A release goes in only signed
# with the app's update key, and only when this app, HOUSE_SHELL, is as new as the release needs; the one it replaces
# waits in $own/ade.old until the new one comes up, and run goes back to it if it doesn't.
set -u
state="${XDG_STATE_HOME:-$HOME/.local/state}/arbe-desktop"
own="${XDG_DATA_HOME:-$HOME/.local/share}/arbe-desktop"
mkdir -p "$state" "$own"
log="$state/house.log"
pidfile="$state/house.pid"
[ -n "$HOUSE_SCRIPT" ] && echo "${WSL_DISTRO_NAME:-}:$log"

# The house this app started: the process in the pid file, alive, carrying the token start gave it; nothing else counts
ours() {
	[ -r "$pidfile" ] || return 1
	read -r pid token < "$pidfile" || return 1
	[ -n "$pid" ] && kill -0 "$pid" 2> /dev/null || return 1
	if [ -r "/proc/$pid/environ" ]; then
		tr '\0' '\n' < "/proc/$pid/environ" | grep -qx "ARBE_DESKTOP_HOUSE=$token"
	else
		# macOS has no /proc: a process leading its own group, as setsid made it
		[ "$(ps -o pgid= -p "$pid" | tr -d ' ')" = "$pid" ]
	fi
}

# Whether the house runs the app's own ade rather than one the user installed
own_ade() { [ "$HOUSE_COMMAND" = ade ] && ! command -v ade > /dev/null; }

# mygo.config.ts's publicKey: a release of ade is signed with the same key as this app's own updates
update_key=0IOUbgQBfrOBWn+70aFQIM2KcbLbWm/nZBzKTYg8vVg=

sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d ' ' -f 1; }

# Node 24 or newer on PATH: the shell's own, else ours, fetched the first time from nodejs.org's newest LTS
node_on_path() {
	command -v node > /dev/null && [ "$(node -p 'process.versions.node.split(".")[0] >= 24' 2> /dev/null)" = true ] && return 0
	PATH="$own/node/bin:$PATH"
	export PATH
	[ -x "$own/node/bin/node" ] && return 0
	case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) platform=darwin-arm64 ;;
	Darwin-x86_64) platform=darwin-x64 ;;
	Linux-x86_64) platform=linux-x64 ;;
	Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
	*)
		echo "There's no Node for $(uname -sm) to fetch; install Node 24 or newer" >&2
		return 1
		;;
	esac
	dist=https://nodejs.org/dist/latest-v26.x
	line="$(curl -fsSL "$dist/SHASUMS256.txt" | grep " node-v[0-9.]*-$platform.tar.gz$")" || {
		echo "Couldn't reach nodejs.org" >&2
		return 1
	}
	file="${line##* }"
	next="$own/node.next"
	rm -rf "$next" && mkdir -p "$next"
	echo "Fetching ${file%.tar.gz}"
	curl -fsSL "$dist/$file" -o "$next/$file" || return 1
	[ "$(sha256 "$next/$file")" = "${line%% *}" ] || {
		echo "$file doesn't match its checksum" >&2
		return 1
	}
	tar -xzf "$next/$file" -C "$next" --strip-components=1 && rm "$next/$file" && rm -rf "$own/node" && mv "$next" "$own/node"
}

# The newest release on GitHub, a tag v<major>.<minor>.<patch>: prints its tag and commit, and writes it as JSON to $1
# with its notes and signature, from the tag's message, and the arbe desktop it needs, from its package.json, unchecked
# until fetch_ade has verified the files. ADE_REPO and ADE_TAGS point a rehearsal elsewhere.
newest_release() {
	node --input-type=module -e '
		const [file, repo, prefix] = process.argv.slice(1)
		const get = async (route) => {
			const response = await fetch(`https://api.github.com/repos/${repo}/git/${route}`, {
				headers: { accept: "application/vnd.github+json" },
			})
			if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
			return response.json()
		}
		const version = (ref) => ref.slice(`refs/tags/${prefix}`.length).split(".").map(Number)
		const newer = (a, b) => version(a.ref).reduce((sign, n, i) => sign || Math.sign(n - version(b.ref)[i]), 0) > 0
		const refs = (await get(`matching-refs/tags/${prefix}`)).filter((ref) => {
			const parts = version(ref.ref)
			return parts.length === 3 && parts.every((n) => Number.isInteger(n) && n >= 0)
		})
		if (!refs.length) throw new Error(`${repo} has no release yet`)
		const newest = refs.reduce((best, ref) => (newer(ref, best) ? ref : best))
		const tag = newest.ref.slice("refs/tags/".length)
		let commit = newest.object.sha, at = "", notes = [], signature = ""
		if (newest.object.type === "tag") {
			const object = await get(`tags/${commit}`)
			commit = object.object.sha
			at = object.tagger.date
			notes = object.message.split("\n").map((line) => line.trim()).filter(Boolean)
			signature = notes.find((line) => line.startsWith("Signature: "))?.slice("Signature: ".length) ?? ""
			notes = notes.filter((line) => !line.startsWith("Signature: "))
		}
		const shell = await fetch(`https://raw.githubusercontent.com/${repo}/${commit}/package.json`)
			.then((response) => response.json())
			.then((json) => json.engines?.["arbe-desktop"]?.match(/\d+\.\d+\.\d+/)?.[0] ?? "", () => "")
		;(await import("node:fs")).writeFileSync(file, JSON.stringify({ tag, commit, at, notes, signature, shell }) + "\n")
		console.log(`${tag} ${commit}`)
	' "$1" "${ADE_REPO:-oskarrough/ade}" "${ADE_TAGS:-v}"
}

# The digest a release's signature covers: SHA-256 over its tag and each of its files, path and SHA-256, in order.
# scripts/release.sh signs it from git archive; GitHub's tarball of the same commit gives the same digest.
digest() {
	node --input-type=module -e '
		const { createHash } = await import("node:crypto")
		const { lstatSync, readdirSync, readFileSync, readlinkSync } = await import("node:fs")
		const path = await import("node:path")
		const [dir, tag] = process.argv.slice(1)
		const sha = (data) => createHash("sha256").update(data).digest("hex")
		const files = readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => !entry.isDirectory())
			.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
			.sort()
		const lines = files.map((file) => {
			const full = path.join(dir, file)
			return `${sha(lstatSync(full).isSymbolicLink() ? readlinkSync(full) : readFileSync(full))} ${file}\n`
		})
		console.log(sha(`${tag}\n${lines.join("")}`))
	' "$1" "$2"
}

# Whether the files in $1 are release $2 as signed, $3, with the update key
verify() {
	node --input-type=module -e '
		const { createPublicKey, verify } = await import("node:crypto")
		const [digest, signature, key] = process.argv.slice(1)
		const x = Buffer.from(key, "base64").toString("base64url")
		const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" })
		try {
			process.exit(verify(null, Buffer.from(digest, "hex"), publicKey, Buffer.from(signature, "base64")) ? 0 : 1)
		} catch {
			process.exit(1)
		}
	' "$(digest "$1" "$2")" "$3" "$update_key"
}

# Whether this app, HOUSE_SHELL, is older than $1, the arbe desktop a release needs; nothing needed is never too old
too_old() {
	[ -n "$1" ] && [ -n "${HOUSE_SHELL:-}" ] || return 1
	node -e '
		const version = (text) => text.split(/[-+]/)[0].split(".").map(Number)
		const [have, need] = process.argv.slice(1).map(version)
		process.exit(need.reduce((sign, n, i) => sign || Math.sign(n - (have[i] ?? 0)), 0) > 0 ? 0 : 1)
	' "$HOUSE_SHELL" "$1"
}

# The newest release into $own/ade.next with its packages, unless $own/ade runs it, it's already there or it didn't
# come up here before (2). It's built in ade.staging and moved in whole, so a folder named ade.next is always complete.
# A release that isn't signed with the update key fails (1); one that needs a newer arbe desktop waits for it (3).
fetch_ade() {
	staging="$own/ade.staging"
	found="$state/newest.json"
	rm -rf "$staging" && mkdir -p "$staging"
	newest="$(newest_release "$found")" || {
		echo "Couldn't find ade's newest release" >&2
		return 1
	}
	tag="${newest% *}"
	commit="${newest#* }"
	for dir in "$own/ade" "$own/ade.next"; do
		[ "$(release_of "$dir")" = "$tag" ] && rm -rf "$staging" && return 2
	done
	[ "$(cat "$own/ade.bad" 2> /dev/null)" = "$tag" ] && rm -rf "$staging" && return 2
	echo "Fetching ade $tag"
	curl -fsSL "https://codeload.github.com/${ADE_REPO:-oskarrough/ade}/tar.gz/$commit" | tar -xz -C "$staging" --strip-components=1 || return 1
	if ! verify "$staging" "$tag" "$(field "$found" signature)"; then
		echo "ade $tag isn't signed with arbe desktop's update key; it stays out" >&2
		rm -rf "$staging"
		return 1
	fi
	need="$(node -p 'require(process.argv[1]).engines?.["arbe-desktop"]?.match(/\d+\.\d+\.\d+/)?.[0] ?? ""' "$staging/package.json")"
	if too_old "$need"; then
		echo "ade $tag needs arbe desktop $need or newer, and this is $HOUSE_SHELL: update arbe desktop, and ade follows" >&2
		rm -rf "$staging"
		return 3
	fi
	echo "Installing its packages"
	(cd "$staging" && npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error) || return 1
	mv "$found" "$staging/.release"
	rm -rf "$own/ade.next" && mv "$staging" "$own/ade.next"
}

# A string field of a JSON file, as JSON.stringify wrote it; empty without one
field() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1" 2> /dev/null; }

# The release an ade folder runs, from its .release; empty without one
release_of() { field "$1/.release" tag; }

# A release staged beside $own/ade takes its place, as the server does when it restarts; the one before waits in
# ade.old until the new one comes up, when the server deletes it
take_staged() {
	[ -f "$own/ade.next/.release" ] || return 0
	rm -rf "$own/ade.old"
	if [ -d "$own/ade" ]; then mv "$own/ade" "$own/ade.old" || return 1; fi
	mv "$own/ade.next" "$own/ade"
}

# This script again, as a process of its own that outlives the app's wait for this one: its arguments go before sh
again() {
	printf '%s\n' "$HOUSE_SCRIPT" > "$state/house.sh"
	action="$1"
	shift
	"$@" env HOUSE_DIR="$HOUSE_DIR" HOUSE_COMMAND="$HOUSE_COMMAND" HOUSE_SHELL="${HOUSE_SHELL:-}" HOUSE_SCRIPT= sh "$state/house.sh" "$action" >> "$log" 2>&1 < /dev/null &
}

case "${1:-status}" in
start)
	if ours; then
		echo running
		exit 0
	fi
	cd "$HOUSE_DIR" || {
		echo "No folder $HOUSE_DIR" >&2
		exit 1
	}
	[ -f "$log" ] && [ "$(wc -c < "$log")" -gt 5000000 ] && mv "$log" "$log.1"
	printf '\n── %s: %s in %s\n' "$(date '+%F %T')" "$HOUSE_COMMAND" "$PWD" >> "$log"
	# Its own session and process group, so it outlives the window and one kill reaches all of it
	token="$(date +%s)$$"
	# macOS has no setsid; perl's does the same
	if command -v setsid > /dev/null; then group=setsid; else group="perl -MPOSIX=setsid -e setsid;exec(@ARGV) --"; fi
	# mise's shims find only the tools mise installed; its exec puts node's own bin, where npm put ade, on PATH
	command -v mise > /dev/null && group="$group mise exec --"
	again run $group env ARBE_DESKTOP_HOUSE="$token"
	echo "$! $token" > "$pidfile"
	sleep 1
	if ! ours; then
		echo "It stopped at once; the log says why: $log" >&2
		tail -n 15 "$log" >&2
		exit 1
	elif own_ade && [ ! -f "$own/ade/bin.js" ]; then
		echo installing
	else
		echo started
	fi
	;;
run)
	cd "$HOUSE_DIR" || exit 1
	own_ade || exec sh -c "$HOUSE_COMMAND"
	node_on_path || exit 1
	if [ ! -f "$own/ade/bin.js" ]; then
		echo "Setting up ade, the first time only"
		fetch_ade || [ $? -eq 2 ] || exit 1
	fi
	take_staged || exit 1
	# A release that stops before it comes up, with the one before it still in ade.old, makes way for that one again,
	# and fetch_ade passes it over; the server's restart into a staged release counts too. If it converted the store,
	# its .restore in ade.old names the backup it took first, which goes back with the old release, never without it.
	while :; do
		node "$own/ade/bin.js"
		code=$?
		[ -f "$own/ade.old/bin.js" ] || exit $code
		bad="$(release_of "$own/ade")"
		echo "$(date '+%F %T'): ade $bad stopped before it came up; going back to $(release_of "$own/ade.old")"
		echo "$bad" > "$own/ade.bad"
		restore="$own/ade.old/.restore"
		if [ -f "$restore" ]; then
			store="$(field "$restore" store)"
			backup="$(field "$restore" backup)"
			echo "Putting back $store from before $bad"
			[ -n "$store" ] && [ -f "$backup" ] && rm -f "$store-wal" "$store-shm" && mv "$backup" "$store" && rm "$restore" || {
				echo "Couldn't put back $store from $backup; the house stays stopped rather than run $(release_of "$own/ade.old") on data it can't read" >&2
				exit 1
			}
		fi
		rm -rf "$own/ade" && mv "$own/ade.old" "$own/ade" || exit 1
	done
	;;
update)
	[ -f "$own/ade/bin.js" ] || exit 0
	if [ -n "$HOUSE_SCRIPT" ]; then
		# A release this app is too old for, told here so the app can say so; fetching it takes too long to wait for
		node_on_path || exit 1
		newest="$(newest_release "$state/newest.json")" || exit 1
		need="$(field "$state/newest.json" shell)"
		if too_old "$need" && [ "$(release_of "$own/ade")" != "${newest% *}" ]; then
			echo "needs-shell ${newest% *} $need"
			exit 0
		fi
		again update
		echo updating
		exit 0
	fi
	lock="$own/update.lock"
	if ! mkdir "$lock" 2> /dev/null; then
		read -r holder < "$lock/pid" 2> /dev/null && kill -0 "$holder" 2> /dev/null && exit 0
	fi
	echo $$ > "$lock/pid"
	trap 'rm -rf "$lock"' EXIT
	node_on_path || exit 1
	fetch_ade
	case $? in
	0) echo "$(date '+%F %T'): staged ade $tag; the page offers Update" ;;
	2) exit 0 ;;
	*) exit 1 ;;
	esac
	;;
digest)
	# For scripts/release.sh, which signs it
	digest "$2" "$3"
	;;
key)
	# The owner key, from beside the store as the CLI reads it, for the window to come in as the owner
	store="${DB_PATH:-${XDG_DATA_HOME:-$HOME/.local/share}/ade/ade.sqlite}"
	cat "$(dirname "$store")/owner.key" 2> /dev/null
	;;
login)
	# pi in a terminal of its own, where you log in to a model with /login; the runner reads its logins as they change
	if command -v pi > /dev/null; then
		pi="$(command -v pi)"
	else
		node_on_path || exit 1
		pi="$own/ade/node_modules/.bin/pi"
		[ -x "$pi" ] || {
			echo "There's no pi here to log in with: npm i -g @earendil-works/pi-coding-agent" >&2
			exit 1
		}
	fi
	file="$state/login.command"
	cat > "$file" <<- EOF
		#!/bin/sh
		PATH='$(printf %s "$PATH" | sed "s/'/'\\\\''/g")'
		export PATH
		cd
		clear
		echo "Type /login and pick a provider. Close this window when you're done."
		echo
		exec '$pi'
	EOF
	chmod +x "$file"
	if [ "$(uname -s)" = Darwin ]; then
		open "$file"
	elif [ -n "${WSL_DISTRO_NAME:-}" ]; then
		cmd.exe /c start "" wsl.exe -d "$WSL_DISTRO_NAME" -e sh "$file" 2> /dev/null
	else
		for terminal in x-terminal-emulator gnome-terminal konsole xfce4-terminal kitty alacritty foot xterm; do
			command -v "$terminal" > /dev/null || continue
			[ "$terminal" = gnome-terminal ] && flag=-- || flag=-e
			setsid "$terminal" $flag sh "$file" > /dev/null 2>&1 < /dev/null &
			exit 0
		done
		echo "No terminal to open; run $pi and type /login" >&2
		exit 1
	fi
	;;
*)
	if ours; then echo running; else echo stopped; fi
	;;
esac
