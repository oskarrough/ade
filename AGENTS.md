# AGENTS.md

## Working here

- Read [FEATURE-MAP.md](FEATURE-MAP.md) first to find the file and function a task touches; update it when you add or move a file or a major function. [GLOSSARY.md](GLOSSARY.md) defines the terms.
- How to run, check, measure and land (try.js, its scripted bot, agent-browser, real data, perf, jj) is in the skill `.agents/skills/ade-workbench/SKILL.md`; load it before you start a server, open a browser, make a workspace or push.
- You may edit and explore in `~/sites/ade` directly, but commit and land only from your own `.work/` jj workspace (`jj workspace add .work/<short-name> -r main`), even for a one-line fix and even alone: `~/sites/ade` is the shared checkout, other workers and Oskar commit there too, and `@-` there can resolve to someone else's commit instead of yours. Scratch files and screenshots go in `~/sites/ade/.work/<your-name>/`, never a shared folder or `/tmp`.
- Commit only your own paths, push `main` yourself, and report a commit id only after `jj log -r main@origin` shows it. If `jj git push` refuses because main moved, fetch and rebase onto it and push again; never force the push or move main backwards to get past the refusal — see the skill's "Landing with jj" for the exact steps.
- Never abandon, restore or revert someone else's work (formatting it is fine); if you need lines someone else is changing, agree in their thread who goes first.
- `~/sites/ade` is Oskar's own checkout; :3000 runs from it and he may have uncommitted edits there. After pushing, bring it up to `main` without disturbing those edits, and change only the files your task needs there.
- While a sprint holds pushes, land as usual but stop before `jj git push`; the lead squashes and pushes at the sprint's end.
- Oskar's own server on :3000 is his live house: through its API or page you may create bots, schedule tasks and switch modules in ade.json, the way he would, when the work calls for it. Never stop or restart it, or write to its SQLite file behind its back; a change that needs that is rehearsed on a copy and handed to Oskar as one command that refuses to run while the server is up.
- Never `pkill`/`killall` anything; stop only the pid you started (`kill $!`). Don't build proxies, harnesses or helper scripts: if ade plus agent-browser can't show it, stop and ask.
- Test in proportion. A style, copy or layout tweak gets no browser check: trust the code, and Oskar reports what looks wrong. Look only for new or redesigned UI. Small changes run no examples; landing runs `pnpm check` and `pnpm examples` once. A model check uses the scripted bot, or `gpt-6-luna:low@oskar` for a real one. Run `pnpm perf` before and after a change to reads, lists or rendering. If a check fails twice, stop and report.
- If you had to work out something about checking that the guide or skill should have said, say it in one line of your report; a new scripted command or check tool goes in the skill in the same commit.
- Leave package.json and the lockfile alone unless the task is about dependencies.
- When you mention a thread to Oskar, use its title, not its number.
- End with a report Oskar could read as is: what changed from where he sits, one plain line each, the commit id, and anything you couldn't check.

## What to build

- A change serves a promise in [apps/client/client.html](apps/client/client.html), or it needs a chat with Oskar. When an idea looks wrong, Oskar's included, argue before building.
- New features are modules, off by default.
- A thread's contract (its entries, their data, what the API returns) and how the client shows it are two decisions. A UI wish is solved in the client from existing entries; change the contract only on purpose, in its own commit, with the README and an example.
- Don't over-fix. A rare failure that would need a new store, task layer or journal stays a known gap, written on its issue.
- Hold the bar of Apple restraint and Bret Victor's directness: show the thing itself, make the invisible visible, keep people in control.
- A new panel, popover, row or button reuses its siblings' markup and styles (header, rows, buttons); nothing custom. FEATURE-MAP.md says where the popover pattern lives.
- Keep client.html and the README saying what the code does. Docs and UI copy read like a person talking.

## Words and names

- The README says what each thing is; use its words, one per concept. A thread has one agent whose model, thinking and runner change in place; only bots have names.
- A name says what it holds and stays the same in every layer, so `rg` finds the whole path (a `To` is `to`). No one-letter names, but `_` and memory's stored `l`, `i` and `n`.

## Code

- `examples/` guards only the promises a user relies on, about twenty of them, through the API, socket or CLI, never server internals, wording or styling. A new example only for a new promise, and it must fail on the old code first (say so). `examples/00-the-api.js` is the README's walkthrough: change both together. No unit or UI tests, no build step, no migrations or shims. Examples wait for the event, not the clock: a delay goes in as a small value (the scripted bot's `sleep 0.5`, a short setting). A flaky example gets its cause fixed or is deleted, never a retry or a longer timeout.
- No backwards compatibility: rename and change things outright, no fallbacks for old names.
- Durability, ordering, retries and cancellation are Pi Durable's: find its primitive before writing your own. A tool's cancellation is `execute`'s third argument's `abortSignal`; pass it through runner calls and settle locally.
- In a Pi commit, `submit(tx, ...)` comes before table writes; after the first write it can't scan entries or snapshot. A snapshot inside a commit deadlocks silently. Copy document values before they leave the commit. A doc's value is a live proxy: `structuredClone` throws "could not be cloned", so copy it with `JSON.parse(JSON.stringify(…))`.
- Pi forks restore `pi.agent` at the fork entry, so the creating commit applies the thread's tools and identity without replacing the inherited model, thinking or folder.
- One web client: Solid 2, no build step, in apps/client. Read `CHEATSHEET.md` and `skills/solid-2.0/SKILL.md` in node_modules/solid-js first; fix `[CODE]` console warnings with `skills/reactivity-diagnostics/SKILL.md`. A row never scans `threads` itself: look one up with `threadOf`, and derive what every row needs in one memo shared above the list; a scan of the whole list reads `threadRows()`, plain rows that change only when a fetch lands, and maps back with `threadOf` where it renders them. In templates, wrap live values in `() =>` and give callbacks an argument; `For` hands its callback the plain item unless it has `keyed=${false}`, which makes it an accessor. Every bare import in the import map is a root dependency. An element filled by `innerHTML` takes no component or live value after it in the same template; give that content its own template.
- Plain module-level signals and stores live with the page, without a root. Keep a root for module-level effects, lifecycle work and owned memos.
- A runner message's own fields never include `id` (the call's id is replaced and no reply matches), and an example needing two models uses a provider that isn't `echo`, whose models all answer as the first. An example that has its runner in its own process (`localRunner`) runs the CLI with async `execFile`, never `execFileSync`, which would stop that runner answering.
- Resolve installed packages (`import.meta.resolve`), never assume `<app>/node_modules`.
- Delete comments that only restate the code in the lines you touch.
- `pnpm check`'s lint rejects `\n` inside a string literal; use `String.raw` instead.
