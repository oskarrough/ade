# ade

Ade is yet another app for working with agents.

> Threads live on a server you own, and agents run on the machines you want, in folders you choose.

The basics:

- one command to start anywhere: `npx github:oskarrough/ade`
- one command to let agents work on another machine
- threads survive crashes, restarts and reloads
- a repeated send with the same key lands once, so a retry or a webhook never posts twice
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

To let agents work on another machine, click "Add runner" (or run `npx github:oskarrough/ade key laptop`) for the command to run there; keep it private, it holds a key.

An agent works on its own runner, but can run a command on any runner that accepts its commands: `runners` lists the house's runners, and `bash` takes a `runner` to run it there, in that runner's folder. Its conversation stays put; a command whose runner drops mid-call reports it may have run.

There are no accounts. The server knows who you are by how you came in. On its own machine, at the address it prints, you're its owner, signing as `owner` in ade.json or else your login there. To let in your other devices and friends, point `tailscale serve` at the second port it prints, the one marked `serve`: everyone who comes through it is their tailnet login, and nobody gets in without one. Everyone in a thread sees who wrote each message, and who pressed Stop. List your own login in ade.json's `ownerLogins` (`["you@github"]`) and you're the owner on every device. Don't point Serve, a tunnel or a proxy at the first port; it turns away anything that came through one. That's it.

Elsewhere, you're the owner with the owner key, which the server writes beside its data at first start (`owner.key`). `ade link` on the server's machine prints a link that brings a browser in with it; the CLI sends it when `ADE_OWNER_KEY` is set.

## Settings

Settings live in `~/.config/ade/ade.json` (or under `$XDG_CONFIG_HOME`), wherever you start. For example, to turn web search on and talk off:

```json
{
	"modules": ["+web-search", "-talk"]
}
```

Use `+` and `-` to change the defaults; a list of bare names replaces them.

Threads live in `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite`, with its SQLite sidecars, lock and `ade.log` beside it. Settings stay in `${XDG_CONFIG_HOME:-~/.config}/ade/ade.json`. `DB_PATH` selects another store and puts its log beside it; it does not move settings.

Server secrets, like `TYPESAFE_API_KEY` and `MATRIX_TOKEN`, go in `${XDG_CONFIG_HOME:-~/.config}/ade/.env`, loaded at start-up if it exists; a variable already set in the shell wins over it.

The server's address, port, Serve port and data file come from the environment (`HOST`, `PORT`, `SERVE_PORT`, `DB_PATH`), and so can `MODULES`. These win over the file. `SERVE_PORT` is the first free one after `PORT` unless you set it; set it, so `tailscale serve` always finds it.

## What it does

So, what's different about this one? Not much, but it adds patterns I've found useful enough to write down. Each is a module; you can switch any of them on or off.

- bots are agents with a name, instructions and a home thread; a new one starts with none, and writes its own once it has something to say. Every bot also reads one shared instruction, a chatty default editable in settings, rendered just before its own (`bots`)
- agents and bots message each other (`talk`); a bot posting in a thread it's in speaks there as itself, and its message carries `posted: true`, so it reads as an agent's, never a person's
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
- agents leave you questions only you can answer, and carry on meanwhile; the thread waits on you until you write, and one inbox lists every open question, answered right there (`inbox`, off by default)
- agents come back to a thread later, once, every so often, or when another thread is done, and you see and cancel what's pending (`wake`, off by default)
- every thread, archived ones included, exports as Markdown and JSON a person can read without ade installed (`export`, off by default)

In a group (the thread's agent plus bots, at least two), leave `to` out to let the director choose who answers, or nobody. The same goes for one agent with two or more people writing, so people talking to each other are left alone; one person with one agent skips the director. The message is saved at once; the director's pick comes after and shows on it as its `to` and `picked`. `@name` asks that bot for one message; the next unaddressed message goes to the director again. Solo chats and `$` commands keep the last recipient.

Each person has their own pending pick. A message waits `burst` seconds of quiet, then holds while anyone in the thread is typing (each beat lasts 6 seconds, the hold at most 20; sending or clearing the composer ends it), then one call picks one candidate, all of them (for a message that asks everyone, each answering in turn) or nobody, with a confidence. The author's next message, an @mention too, takes over their pending pick: the older message asks no one and says nothing, and the newer one's pick reads both. Someone else's message gets a pick of its own. With `TYPESAFE_API_KEY` set on the server, TypeSafe's Jev makes the choice; otherwise the chooser model below does. A pick that fails says so on its message. With the Director tab open beside a group thread, you watch each message arrive, the wait, who's typing, the model call, any dropped pick and the pick with its reason and confidence; none of it is stored.

A thread's Paused switch, in its details, makes it answer only @mentions and named recipients. Replies already on their way finish, and resuming replays nothing.

A message you send while an agent works waits until the agent picks it up. Until then, its × takes it back: it's never handed to the agent, and nobody sees it any more. Once an agent has picked it up, it stays.

The chooser is a small model on the thread agent's runner (the first bot's in a bot-only group): Haiku for Anthropic or Claude Code agents, Luna otherwise, with thinking off; if the runner doesn't list it, the agent's own model with thinking off. Settings' director row, or `director` in ade.json, changes it: `model` as `provider/model:thinking`, optionally `@runner` (`DIRECTOR_MODEL` wins over it); `context`, how many recent messages it reads (20, up to 200); `timeout`, the seconds before a pick fails (60, 0.1 to 600); and `burst`, the quiet it waits for after the last message (1.5 seconds, 0 to 60). After the timeout, an error, or an invalid pick, the thread's agent answers instead. The message's `picked` line says the pick failed; bot-only groups report the failure without asking anyone. `director.picks: false` disables model picks without restoring sticky group recipients.

With `inbox` on, `ask_person` posts the agent's question in the thread and returns at once: the agent goes on with what doesn't depend on the answer, or ends its turn, and your reply reaches it as an ordinary message. Its message carries `waitingOnPerson: true`; the latest marked question stays open until any person posts a message after it, and a newer question replaces an older open one. Agent messages and reads do not clear it, and restarts keep it. The same dot also marks threads waiting for an offline runner. The sidebar's Inbox lists every open question, newest first, with its thread, who asked, when, and the recap's line when `recap` is on. You answer under the question as you would in its thread, and it leaves the inbox; Dismiss hides it until that thread asks again, on every device.

With `wake` on, an agent's `wake({in, every, note})` returns at once; when its time comes, or with `wake({after: N, note})` once thread N has no work left (at once if it has none), its note arrives in the thread as a message from that agent to itself, marked `wake`, and it answers as to any message. A wake survives a restart (one due while the server was down fires once on start, and a repeating one keeps its rhythm, skipping the slots it missed) and the thread's Stop, and follows its agent through a bot's rename; above the composer each pending wake says when and what, and × cancels it. Archiving the thread cancels them all. Waking on an outside event comes later.

For each module's settings, see the top of its file in [modules/](modules). A module there with `export const on = true` is on by default; a new file there is a new module.

Scripting it? See [the API and CLI](docs/api.md).
