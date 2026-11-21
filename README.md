# ade

Ade is yet another app for working with agents.

> Threads live on a server you own, and agents run on the machines you want, in folders you choose.

The basics:

- one command to start anywhere: `npx github:oskarrough/ade`
- one command to let agents work on another machine
- threads survive crashes, restarts and reloads
- works with any model provider, via pi

I run it on my office computer, which is always on, at localhost:3000. That's all I need for daily work, and my laptop and home PC can join as runners when I want agents working there.

## Start

Install [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and log in: `pi`, then `/login` with any provider. Then, in the folder you want agents to work in:

```sh
npx github:oskarrough/ade
```

`pnpm dlx` and `bunx` work just as well, or fork/clone the repo and `npm link` (or `pnpm link`) it to get an `ade` command.

Open the address it prints for the chat app; add `?story` for the walkthrough.

Agents start in the folder you run it from. Add shortcuts with `--dir ~/sites --dir ~/notes`; threads start in the first, and the folder picker suggests them all. A thread can start in any folder on the machine, though: type its path in the picker. Ade has no sandbox: doing one properly is hard, and a half-baked one would only make you feel safe.

To let agents work on another machine, click "Add runner" (or run `npx github:oskarrough/ade key laptop`) for the command to run there; keep it private, it holds a key. There are no accounts, so reach the server only over Tailscale: `tailscale serve <port>`, using the port ade printed. That's it.

## Settings

Settings live in `~/.config/ade/ade.json` (or under `$XDG_CONFIG_HOME`), wherever you start. For example, to turn web search on and talk off:

```json
{
	"modules": ["+web-search", "-talk"]
}
```

Use `+` and `-` to change the defaults; a list of bare names replaces them.

Threads live in `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite`, with its SQLite sidecars, lock and `ade.log` beside it. Settings stay in `${XDG_CONFIG_HOME:-~/.config}/ade/ade.json`. `DB_PATH` selects another store and puts its log beside it; it does not move settings.

The server's address, port and data file come from the environment (`HOST`, `PORT`, `DB_PATH`), and so can `MODULES`. These win over the file.

## What it does

So, what's different about this one? Not much, but it adds patterns I've found useful enough to write down. Each is a module; you can switch any of them on or off.

- bots are agents with a name, instructions and a home thread; a new one starts talking like a person in a chat, and rewrites that in its own words once it has something to say (`bots`)
- agents and bots message each other (`talk`)
- group messages go to the thread, not the last bot you asked; the director picks who answers, including the thread's agent (`director`)
- bots remember long threads as short summary lines they can zoom back into, so they can stick around for good (`memory`)
- agents get their folder's AGENTS.md and skills, like in pi (`context`)
- see what agents are doing on a runner's terminal (`status`)
- threads get a short title once their first message is answered (`auto-title`)
- agents can search the web (`web-search`, off by default)
- Matrix rooms become threads (`matrix`, off by default)
- a short recap per thread says where it stands (`recap`, off by default)
- a canvas per thread that people and agents draw on together, with tldraw (`canvas`, off by default)
- move threads to and from pi (`pi-sessions`, off by default)
- agents leave you questions only you can answer, and carry on meanwhile; the thread waits on you until you write (`blocked`, off by default)
- one inbox for every question agents ask you, answered right there (`inbox`, off by default, with `blocked`)

In a group (the thread's agent plus bots, at least two), leave `to` out to let the director choose who answers, or nobody. The message is saved at once; the director's pick comes after and shows on it as its `to` and `picked`. `@name` asks that bot for one message; the next unaddressed message goes to the director again. People don't count toward the group. Solo chats and `$` commands keep the last recipient.

Each thread has one queue. A message waits `burst` seconds of quiet, then one model call picks for it from the messages before it. Another message in the meantime, or while that call runs, cancels it: the older message asks no one and says nothing, and the newer one's pick reads both. An @mention takes over the same way, so the bot it asks reads the older message too and nobody answers it twice. With the Director tab open beside a group thread, you watch each message arrive, the wait, the model call, any dropped pick and the pick with its reason; none of it is stored.

The chooser is a small model on the thread agent's runner (the first bot's in a bot-only group): Haiku for Anthropic or Claude Code agents, Luna otherwise, with thinking off; if the runner doesn't list it, the agent's own model with thinking off. Settings' director row, or `director` in ade.json, changes it: `model` as `provider/model:thinking`, optionally `@runner` (`DIRECTOR_MODEL` wins over it); `context`, how many recent messages it reads (20, up to 200); `timeout`, the seconds before a pick fails (60, 0.1 to 600); and `burst`, the quiet it waits for after the last message (1.5 seconds, 0 to 60). After the timeout, an error, or an invalid pick, the thread's agent answers instead. The message's `picked` line says the pick failed; bot-only groups report the failure without asking anyone. `director.picks: false` disables model picks without restoring sticky group recipients.

With `blocked` on, `ask_person` posts the agent's question in the thread and returns at once: the agent goes on with what doesn't depend on the answer, or ends its turn, and your reply reaches it as an ordinary message. Its message carries `waitingOnPerson: true`; the latest marked question stays open until any person posts a message after it, and a newer question replaces an older open one. Agent messages and reads do not clear it, and restarts keep it. The sidebar's Blocked filter lists blocked threads, including child threads and bot homes; the same dot also marks threads waiting for an offline runner.

With `inbox` on too, the sidebar's Inbox takes the Blocked filter's place: every open question, newest first, with its thread, who asked, when, and the recap's line when `recap` is on. You answer under the question as you would in its thread, and it leaves the inbox; Dismiss hides it until that thread asks again, on every device.

For each module's settings, see the top of its file in [modules/](modules). A module there with `export const on = true` is on by default; a new file there is a new module.

Scripting it? See [the API and CLI](docs/api.md).
