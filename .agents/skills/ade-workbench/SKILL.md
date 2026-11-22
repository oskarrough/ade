---
name: ade-workbench
description: How to run, check and measure ade while working on it - the try.js scratch server and its scripted bot's commands, the CLI, agent-browser, a copy of the real data, a real-model runner, pnpm perf, pnpm fuzz, and jj workspace mechanics. Load it before you start a server, open a browser, measure a run, or work in a .work/ workspace.
---

# Ade workbench

AGENTS.md has the rules; this is the how.

## Workspace and landing

- `jj workspace add .work/<name> -r main`, then `pnpm install --frozen-lockfile`. Workspaces have no `.git`: use `jj status`, `jj file list`, `jj log -r main@origin`. Scratch files and screenshots go in `~/sites/ade/.work/<your-name>/`, which outlives the workspace.
- Run `set -o pipefail; pnpm check` once, uncut (piping it through `tail` hides a failure), and add `&& pnpm examples` unless the change is client-only (apps/client: CSS, copy, markup, client JS); then commit only your paths: `jj commit -m … <paths>`, and keep the id it prints. Check `jj diff -r <id> --git` holds only your lines.
- `jj git fetch`, `jj rebase -s <id> -o main@origin` (`-s`, not `-r`, or the commit stays behind), `jj bookmark set main -r <id>`, `jj git push`. If SSH is refused, push over HTTPS with the GitHub CLI login.
- A refused push ("stale info", a conflicted bookmark) means main moved: fetch, rebase onto `main@origin`, set the bookmark, push again. Never `--allow-backwards`, `--ignore-immutable` or a forced push; that's how main has lost commits before. If it won't converge because of a real conflict, stop and report.
- Then bring Oskar's checkout up: in `~/sites/ade`, `jj rebase -s default@ -o main`, and `jj workspace update-stale` if it says stale. Conflicts in files you didn't touch are his. Finally `jj workspace forget` yours and delete its folder.
- A long run can leave your workspace stale when main moves; copy your changed files aside before `jj workspace update-stale`, and check `jj status` still has them.

## A scratch server: try.js

Start `node scripts/try.js &` from `.work/<your-name>/`, since it writes files where it starts, and keep `$!` with absolute log and pid paths. Its store lives in a fresh temp folder deleted the moment it exits, so there's no restarting try.js itself on the same data; for that, run `server.js` directly with your own `DB_PATH` and `XDG_CONFIG_HOME` (as under "Real data" below) and start it again with the same ones. In a second it has bots and director on, three bots (bot1, bot2, bot3) that answer with their name, persona and what they were handed, a real runner on the scripted model `echo/try@bot`, and one answered thread. It prints its address, its Serve port (people come in with `Tailscale-User-Login`), the `export ADE_SERVER=…` for the CLI and the `kill` that stops it.

`MODULES=+web-search node scripts/try.js` layers module changes on its own list; try.js locks module switches, so the settings panel's Save can only be exercised through memory's compact-at field. A shell started from a server's runner inherits `SERVE_PORT` and `MODULES`: start a scratch server with `env -u SERVE_PORT -u MODULES …` or it takes the real one's. try.js drops every provider key (`*_API_KEY`, `*_TOKEN`, `ANTHROPIC_*`, `AWS_*` and the like) from what its server and runner see, so a scratch run never reaches a paid model; a real model goes through the runner under "Real data" below.

To take a runner offline mid-work, kill its node process (`pgrep -f "^node [^ ]*runner.js --server <url> --name <name> "`), not the wrapper shell.

What a message to `echo/try@bot` makes it do:

- `slow` runs a 5-second tool; `post` asks another thread (`post to 12` follows up in thread 12), and `slow post` carries `slow` over; `think <text>` is a turn that only thinks; `fail` fails the run; `sleep 0.5` delays it.
- `ask <question>` calls `ask_person` (`+inbox`, one-person threads only); `search <words>` calls `search` (`+search`).
- `schedule 5m …`, `schedule every 1h …`, `schedule daily 09:00 …` and `schedule mon,fri 09:00,17:30 …` set tasks (`+schedule`); `schedule on hook …` answers with its `/hooks/<id>` path (`+schedule,+hooks`); `GET /api/threads/N/hooks?task=<id>` gives its secret.
- `bot <instructions>` and `bot append <line>`, in a bot's home.

Only the model is scripted; skills, AGENTS.md and modules load as usual. To catch an agent mid-run, send `slow` to `echo/try@bot` (a named bot answers before its tool runs) and act while the tool shows as running.

A change to how transcript rows, sidebar dots or reply labels render gets checked in more than one plain thread: a solo worker thread, a bot home with an unread child, a group of two people and two bots, a thread with cross-thread asks and a worker report, and one with a scheduled task above its composer.

## The CLI

`node cli.js post --to bot1 --to bot2 "hi"` starts a thread and prints the answers; `post --thread N "@bot3 …"` writes and waits; `--no-wait` then `wait N`; `read N --after id`; `threads`. Naming a bot invites it.

## In the browser: agent-browser

- `agent-browser --session <yours> open <url>`; add `?story` for the walkthrough. `--headers` doesn't reach the app on `open`: run `set headers` first.
- `fill` sets text without key events; anything that reacts to typing, like the @mention list, needs `keyboard type`.
- Read back with `node cli.js wait N`, `snapshot`, or one `eval` of `document.querySelector('.thread').innerText`. `eval` takes no top-level `await`; return the promise.
- Give it absolute paths, and read a screenshot only after its command returned.
- It has no mouse, so `@media (hover: hover)` rules never show; check those in the CSS and say so.
- `--init-script <repo>/scripts/page-spy.js` records what a page fetches and hears (read `spy` with `eval`); `--init-script <repo>/scripts/solid-attribution.js` attributes Solid cost warnings.
- To fake arbe desktop, set `window.mygo = {call: () => Promise.reject(new Error('fake')), on: () => () => {}}` and the CSS vars `desktop.js` reads, `--mygo-titlebar-height: 48px; --mygo-titlebar-inset-right: 138px` (Windows values), on `:root`; put both in an `--init-script` so they're there again after a reload.

## Real data, a real model, measuring

- Real data: copy `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite` and run `PORT=<free> DB_PATH=<copy> node server.js --no-runner` (without the flag it starts a runner called "oskar" that competes with the real one). `DB_PATH` doesn't move settings; point `XDG_CONFIG_HOME` at a scratch folder for that.
- A real model: `POST /api/runners {"name":"oskar"}` for a key, then `ADE_KEY=<key> node runner.js --server <url> --name oskar --dir <folder>`, and use `gpt-6-luna:low@oskar`.
- A run's tool calls and token usage: `GET /api/conversations/:id`, the agent's `conversation` from `GET /api/threads/N`.
- `pnpm perf` copies the real store into `.work/perf/` and times the lists, the biggest thread, the socket and page load; `--why` names the costly statements. Its `typing in N meanwhile` line is the one for drafts and typing.
- `pnpm fuzz [3m]` lets Bombadil click, type and reload around a fresh try.js for that long, one headless Chrome at the lowest priority, and prints `nothing broke` or the broken property with its replay command; log and trace go in `.work/fuzz/<time>/`, and `node_modules/.bin/bombadil browser inspect <trace>` shows it step by step. What it holds the client to is `scripts/fuzz-spec.js`: no errors, drafts that survive leaving and reloading, sends that land or come back, each thread once in the sidebar. A property's bookkeeping lives in an extractor and sessionStorage, not module variables, which Bombadil doesn't keep across states. It's on demand, not part of `pnpm check`. Bombadil stops dead on a lone surrogate in any text it reads (`decoding response for Debugger.evaluateOnCallFrame`): that's a string cut mid-character, an ade bug to fix where it's cut.

## Packaging

After packaging changes, prove npm and npx installs; Chord's optional `ws` peer must fit the root range.
