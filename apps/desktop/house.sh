# arbe desktop's house: starts or tells the state of the ade server and runner it started, in a login shell on
# the machine (inside WSL on Windows). main.go puts HOUSE_DIR and HOUSE_COMMAND above this. The first line it prints
# is "<WSL distro>:<log file>", the last the state: running, stopped or started.
# It keeps the process group and a token in the pid file; stop it with kill -TERM -- -<pid>, the pid file's first word.
set -u
state="${XDG_STATE_HOME:-$HOME/.local/state}/arbe-desktop"
mkdir -p "$state"
log="$state/house.log"
pidfile="$state/house.pid"
echo "${WSL_DISTRO_NAME:-}:$log"

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

case "${1:-status}" in
start)
	if ours; then
		echo running
		exit 0
	fi
	cd "$HOUSE_DIR" || { echo "No folder $HOUSE_DIR" >&2; exit 1; }
	[ -f "$log" ] && [ "$(wc -c < "$log")" -gt 5000000 ] && mv "$log" "$log.1"
	printf '\n── %s: %s in %s\n' "$(date '+%F %T')" "$HOUSE_COMMAND" "$PWD" >> "$log"
	# Its own session and process group, so it outlives the window and one kill reaches all of it
	token="$(date +%s)$$"
	# macOS has no setsid; perl's does the same
	if command -v setsid > /dev/null; then detach=setsid; else detach="perl -MPOSIX=setsid -e setsid;exec(@ARGV) --"; fi
	# mise's shims find only the tools mise installed; its exec puts node's own bin, where npm put ade, on PATH
	command -v mise > /dev/null && detach="$detach mise exec --"
	$detach env ARBE_DESKTOP_HOUSE="$token" sh -c "$HOUSE_COMMAND" >> "$log" 2>&1 < /dev/null &
	echo "$! $token" > "$pidfile"
	sleep 1
	if ours; then
		echo started
	else
		echo "It stopped at once; the log says why: $log" >&2
		tail -n 15 "$log" >&2
		exit 1
	fi
	;;
*)
	if ours; then echo running; else echo stopped; fi
	;;
esac
