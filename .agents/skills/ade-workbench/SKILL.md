---
name: ade-workbench
description: How to run, check and measure ade while working on it - the try.js scratch server and its scripted bot's commands, the CLI, agent-browser, a copy of the real data, a real-model runner, pnpm perf, and jj workspace mechanics. Load it before you start a server, open a browser, measure a run, or work in a .work/ workspace.
---

# Ade workbench

AGENTS.md has the rules (what to test, what's off limits on :3000). This is the how.

## A scratch server: try.js

`node scripts/try.js &` starts a scratch server in a second with bots and director on, three bots (bot1, bot2, bot3) that answer at once with their name, persona, how many messages they were handed and the newest, a real `runner.js` in the caller's current folder with the scripted model `echo/try@bot`, and one answered thread. Start it from `.work/<your-name>/`, since it writes files like `notes.md` into whatever folder it's started from. It prints its address, its Serve port, for example "serve http://127.0.0.1:NNNN (people come in by Tailscale-User-Login)", the `export ADE_SERVER=…` for the CLI, and the `kill` that stops it.

`MODULES=+web-search node scripts/try.js` turns on more modules, as +/- changes layered on top of its own list. try.js locks module switches through `MODULES`, so the settings panel's Save count can only be exercised through memory's compact-at field there.

Before backgrounding a server, `cd` into your workspace first; start it and capture `$!` in the same shell, with absolute log and pid paths. To take a runner offline mid-work, kill its node process (`pgrep -f "^node [^ ]*runner.js --server <url> --name <name> "`), not the shell you backgrounded it from: when `$!` is a wrapper shell, killing it leaves the runner up, and the work you meant to strand just finishes. A shell started from a server's runner inherits that server's ade environment, like `SERVE_PORT` and `MODULES`: unset them before starting a scratch server (`env -u SERVE_PORT -u MODULES …`), or it takes the real one's ports and modules. Examples drop them already.

### The scripted bot's commands

What a message to `echo/try@bot` makes it do:

- `slow` runs a 5-second tool. `post` makes it ask another thread, and `slow` carries over to the thread it asks, so `slow post` gives a live exchange to watch. `post to 12` follows up in thread 12 instead of starting a new one. `think <text>` gives a turn that is only a thought.
- A message of just `fail` makes its run fail, as a model error would.
- With `MODULES=+inbox`, a message starting `ask <question>` makes it call `ask_person`, but only in a thread with one person in it, since with several people messages arrive wrapped with the sender's name.
- With `MODULES=+search`, a message starting `search <words>` makes it call `search` and answer with what it found.
- With `MODULES=+schedule`, `schedule 5m <instructions>` schedules a one-off task, `schedule every 1h <instructions>` a repeating one, and `schedule daily 09:00 <instructions>` one by the clock (also hourly, weekdays, weekly). A person's task goes through `POST /api/schedule` or the Scheduled tasks list's New task.
- With `MODULES=+schedule,+hooks`, `schedule on hook <instructions>` schedules a task on its hook and answers with its `/hooks/<id>` path. try.js prints the hooks address, `GET /api/threads/N/hooks?task=<id>` gives the secret to curl it with, and `POST … {task: <id>, raw: true}` lets the sender's text through.
- `bot <instructions>` in a bot's home exercises its `bot` tool; `bot append <line>` adds one line.
- `sleep 0.5` delays it, for examples that need a small delay.

try.js's `bot` runner loads skills, AGENTS.md and runner modules normally; only the echo model is scripted.

To test anything that needs an agent mid-run, like taking back a waiting message, send `slow` to a thread on the scripted `echo/try@bot`, not to a named bot, whose reply comes back before the tool runs; wait until the tool shows as running, then send and act within the same check, since the window closes when the tool ends.

A change touching how transcript rows, sidebar dots or reply labels render has slipped past checks that only looked at one plain thread before, so open a solo worker thread, a bot home with an unread child thread, a group of two people and two bots, a thread with cross-thread asks and an incoming worker report, and a thread with a scheduled task above its composer, before landing. Build them with the scripted bot's own commands: `schedule 5m <instructions>` for the scheduled task, `post` (and `post --to` a second bot) for the group and cross-thread asks, and `ask <question>` for the worker report.

### The CLI

Each step is one command: `node cli.js post --to bot1 --to bot2 "hi"` starts a thread and prints the answers; `post --thread N "@bot3 …"` writes and waits; `post --thread N --no-wait …` then `wait N` waits for the answers; `read N --after id` shows what's new; `threads` lists them. Sending to a bot by name invites it.

## In the browser: agent-browser

- `agent-browser --session <yours> open <url>` opens straight on the chat app. `--headers` doesn't reach the app on `open`; run `set headers` first, for example to come in with a `Tailscale-User-Login` through the Serve port. Add `story` to its query (`/?story`) for the walkthrough instead.
- `fill textarea "<text>"`, `press Enter`. `fill` sets text without key events, so anything that reacts to typing, like the @mention list, needs `keyboard type`; pick an option with `click` on its CSS selector, or `tap @ref` from `snapshot` at phone width.
- Read back with `node cli.js wait N`, `snapshot` (the model button's name says whom the message asks), or one `eval` of `document.querySelector('.thread').innerText`; a run's steps show once you click `li.turn:last-of-type summary`.
- Give agent-browser absolute paths, since it saves relative to its own folder, and read a screenshot only after the command that made it has returned, since calls sent together run at once.
- agent-browser never reports a mouse, so hover rules inside `@media (hover: hover)` show only on a real one; check those in the CSS and say so.
- For what a page fetches, hears on its socket, or stalls on, open it with `--init-script <repo>/scripts/page-spy.js` (an absolute path) and read `spy` back with `eval`; `eval` takes no bare top-level `await`, so return the promise instead.
- The `@solidjs/diagnostics` agent loop and Vite plugin the Solid warnings' footers mention aren't installed here. For a Solid cost warning (`HUGE_FAN_IN`, `HOT_SCOPE_*`), open the page with `--init-script <repo>/scripts/solid-attribution.js`; `WIDE_SCOPE_DEPS` names the sources.

## Real data, a real model, measuring

- Real data: `PORT=<free> DB_PATH=<your copy>.sqlite node server.js --no-runner` on a copy of `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite`. Without `--no-runner` it brings up its own runner as "oskar" and competes with the real one. Set `XDG_CONFIG_HOME` to a scratch folder with its own `ade/ade.json` for isolated settings; `DB_PATH` moves the store and log, not config.
- A real model: `POST /api/runners {"name":"oskar"}` for a key and start `ADE_KEY=<key> node runner.js --server <url> --name oskar --dir <workspace folder>` beside it. Use `gpt-6-luna:low@oskar`.
- To measure a run, read its agent's conversation with `GET /api/conversations/:id` (the id is the agent's `conversation` in `GET /api/threads/N`): every tool call and each answer's token usage are there.
- `pnpm perf` (under a minute) copies the real store into `.work/perf/` and prints how long each list and the biggest thread take to read and how many rows, what one open page hears on its socket, and how fast that page loads and opens the big thread; add `--why` to see which statements cost most. Its `typing in N meanwhile` line saves a draft in the biggest thread ten times a second during the posts above it, five times what a page sends, and times those saves; a change to drafts or typing reads that line and the post line above it.

## Landing with jj

- Land only from your own `.work/` workspace (see "jj workspaces" below), never from the shared checkout at `~/sites/ade`. That checkout's `@` is the default workspace, and others (Oskar included) commit there too; two commits landing around the same time there means `@-` can resolve to someone else's commit instead of yours, and you'd rebase and push that. Your own workspace's `@` is yours alone.
- Commit only your own paths with `jj commit -m … <paths>`, and note the commit id it prints (or read it back with `jj log -r @- -T 'commit_id.short()' --no-graph`). Use that id, not a bare `@-`, for every step below — nothing else in your own workspace moves it, but naming it is cheap insurance and makes retries unambiguous. Before pushing, `jj diff -r <id> --git` to check it holds only your lines.
- Then fetch, rebase onto `main` with `jj rebase -s <id> -o main` (not `-r <id>`, which moves only the empty change and leaves the commit off `main`), `jj bookmark set main -r <id>`, `jj git push`. If SSH is refused, use HTTPS with the GitHub CLI login, and check the output says main moved.
- If `jj git push` refuses the move ("stale info", bookmark conflicted, or main moved on the remote), that's jj checking for you that main didn't move backwards or lose a commit — treat it as news, not an error to push through. Re-fetch, rebase your id onto `main@origin` (the bookmark may be conflicted after the fetch; rebasing explicitly onto `main@origin` and then `jj bookmark set main -r <id>` again resolves that), and push again. Repeat until it lands. Never pass `--allow-backwards` or `--ignore-immutable`, and never force a push to make the rejection go away — those are how main has moved backwards or lost a commit before. If retrying doesn't converge (a real conflict in the diff, not just a moved main), stop and report instead of forcing.
- In a sprint that holds pushes, do all of this except `jj git push`, then forget the workspace.
- Bring Oskar's checkout up: in `~/sites/ade`, `jj rebase -s default@ -o main` (rebases his in-progress working-copy commit onto the new `main`; resolve conflicts only in files you both touched, otherwise they're his to settle), then `jj workspace update-stale` if it reports the working copy is stale.

## Packaging

`pnpm install --frozen-lockfile` in a fresh checkout or workspace. After packaging changes, prove npm and npx installs; Chord's optional `ws` peer must fit the root range.

## jj workspaces

- Make one with `jj workspace add .work/<short-name> -r main` before you land anything, even a one-line fix — not only for parallel or big work. All workspaces, including Oskar's own checkout, share one jj store, so your workspace's `@` is private to you, but the shared checkout's `@` isn't private to anyone. Then `pnpm install --frozen-lockfile`. When done, `jj workspace forget` it and delete its folder.
- Screenshots and scratch files still go in `~/sites/ade/.work/<your-name>/`, since a workspace's folder is deleted when you're done, and never in `/tmp`, which file tools can't reach.
- Workspaces have no `.git`: use `jj status`, `jj file list` and `jj log -r main@origin` to inspect them.
- A long run in a workspace, like a real-model bench, can leave its working copy stale when others move `main` meanwhile; copy your changed files aside before `jj workspace update-stale`, then check `jj status` still has them.
