# AGENTS.md

## Working here

- [FEATURE-MAP.md](FEATURE-MAP.md) says which file and function a task touches; update it when you add or move one. [GLOSSARY.md](GLOSSARY.md) defines the terms.
- Load `.agents/skills/ade-workbench/SKILL.md` before you start a server, open a browser or land: it's how to run, check, measure and push.
- Land only from your own jj workspace (`jj workspace add .work/<name> -r main`), made before your first edit, not just before landing, even a one-line fix. `~/sites/ade` is Oskar's checkout, shared with other workers; its `@-` can be someone else's commit, and it's never where you edit. Scratch files go in `.work/<your-name>/`, never `/tmp`.
- Commit only your own paths and push `main` yourself. If the push is refused, fetch, rebase and push again; never force it or move main backwards. Report a commit id only once `main@origin` has it. While a sprint holds pushes, stop before `jj git push`. After pushing, bring `~/sites/ade` up to main without touching Oskar's uncommitted edits.
- Commit subjects are the changelog, shown in the app: one plain sentence for the person using ade, benefit first ("Forking a long thread is instant", not "fork: read only needed entries"); internal work says so ("Server code is simpler, nothing changes for you"). The why and how go in the body. Voice: `~/.agents/skills/arbe-changelog/SKILL.md`.
- Never abandon, restore or revert someone else's work. If you need lines someone else is changing, agree in their thread who goes first.
- :3000 is Oskar's live house. Use it through its API or page as he would, but never stop or restart it or write to its SQLite file; a change that needs that is rehearsed on a copy and handed to Oskar as one command that refuses to run while the server is up.
- Never `pkill` or `killall`; stop only the pid you started. Build no proxies, harnesses or helper scripts: if ade and agent-browser can't show it, ask.
- Test in proportion. A style, copy or layout tweak gets no browser check; look only at new or redesigned UI. Landing always runs `pnpm check`; `pnpm examples` runs too unless the change is client-only (apps/client: CSS, copy, markup, client JS). Run `pnpm perf` before and after a change to reads, lists or rendering. If a check fails twice, stop and report.
- Leave package.json and the lockfile alone unless the task is about dependencies.
- If only Oskar can decide or confirm something, use ask_person before ending your turn; don't leave the ask in your report for the lead to relay. Anything the lead can decide stays in the report.
- End with a report Oskar can read as is: what changed from where he sits, one line each, the commit id, and what you couldn't check. Name threads by title. If the skill should have told you something about checking, say so in one line.

## What to build

- A change serves a promise in [apps/client/client.html](apps/client/client.html), or it needs a chat with Oskar. When an idea looks wrong, Oskar's included, argue before building.
- New features are modules, off by default.
- A thread's contract (its entries, their data, what the API returns) and how the client shows it are two decisions. Solve a UI wish in the client; change the contract only on purpose, in its own commit, with the README and an example.
- Don't over-fix. A rare failure that would need a new store, task layer or journal stays a known gap, written on its issue.
- Apple restraint, Bret Victor directness: show the thing itself, make the invisible visible, keep people in control. New UI reuses its siblings' markup and styles.
- The README and client.html say what the code does, and read like a person talking.

## Words and names

- One word per concept, the README's. Only bots have names; a thread's one agent changes model, thinking and runner in place.
- A name stays the same in every layer, so `rg` finds the whole path (a `To` is `to`). No one-letter names but `_` and memory's stored `l`, `i` and `n`.

## Code

- `examples/` guards the twenty-odd promises users rely on, through the API, socket or CLI, never internals, wording or styling. Add one only for a new promise, and see it fail on the old code first. `examples/00-the-api.js` is the README's walkthrough: change both together. Examples wait for events, not the clock; a flaky one gets its cause fixed or is deleted.
- No unit or UI tests, build step, migrations, shims or backwards compatibility: rename outright.
- Durability, ordering, retries and cancellation are Pi Durable's; use its primitives. A tool's cancellation is `execute`'s third argument's `abortSignal`; pass it through runner calls.
- In a Pi commit, `submit(tx, …)` comes before table writes, and a snapshot inside it deadlocks silently. A doc's value is a live proxy: copy it with `JSON.parse(JSON.stringify(…))` before it leaves the commit.
- Pi forks restore `pi.agent` at the fork entry, so the creating commit sets tools and identity without replacing the inherited model, thinking or folder.
- The client is Solid 2 with no build step. Read `CHEATSHEET.md` and `skills/solid-2.0/SKILL.md` in node_modules/solid-js first, and fix `[CODE]` warnings with `skills/reactivity-diagnostics/SKILL.md`. A row looks its thread up with `threadOf` and never scans `threads`; what every row needs is one memo above the list, and a whole-list scan reads `threadRows()`. In templates wrap live values in `() =>`; `For` hands over the plain item unless `keyed=${false}`. An `innerHTML` element takes nothing live after it in the same template. Module-level effects and owned memos need a root; plain signals don't. Every bare import in the import map is a root dependency.
- A runner message has no `id` of its own. An example needing two models uses a provider other than `echo`; one with its runner in-process calls the CLI with async `execFile`.
- Resolve packages with `import.meta.resolve`. Delete comments that restate the code. Lint rejects `\n` in a string literal; use `String.raw`.
