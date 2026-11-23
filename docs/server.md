# Running the server

Runners, who gets in, settings, and where things live.

## Runners

On the server's own machine, `ade runner` in a folder lends that folder too, as a runner named after it; it makes its own key. A name that already holds a key belongs to another runner, offline or not: `ade runner` asks for its own name, and takes that one over only when you name it with `--name`. A new key for a runner that has one, from Add runner or `ade key`, says it replaces it.

Nothing moves to another runner on its own. When work waits for a runner that's offline, a thread's agent, a bot asked there, or a scheduled task that starts a new thread on it, it says so: "vps is offline. Run on", with a button for each online runner that has its model. Pressing one moves it there, as picking that runner in the model picker would: same model and thinking, its folder starting over in that runner's, and a turn held up by the runner it leaves goes on there. For a bot, the bot moves, so asking it anywhere asks it there; for a scheduled task, its runs start there from now on. The model picker lists offline runners greyed out, and says when a pick on another runner starts the folder over.

An agent works on its own runner, but can run a command on any runner that accepts its commands: `runners` lists the house's runners, and `bash` takes a `runner` to run it there, in that runner's folder. Its conversation stays put; a command whose runner drops mid-call reports it may have run.

Agents start in the folder you run ade from. Add shortcuts with `--dir ~/sites --dir ~/notes`; threads start in the first, and the folder picker suggests them all. A thread can start in any folder on the machine, though: type its path in the picker. Ade has no sandbox: doing one properly is hard, and a half-baked one would only make you feel safe.

To update, stop the server and run the same `npx` line: npx fetches the newest commit when there is one, and runners on other machines follow the server on their own. `pnpm dlx` and `bunx` work just as well, or fork/clone the repo and `npm link` (or `pnpm link`) it to get an `ade` command.

## Who you are

There are no accounts. The server knows who you are by how you came in. On its own machine, at the address it prints, you're its owner, signing as `owner` in ade.json or else your login there. To let in your other devices and friends, point `tailscale serve` at the second port it prints, the one marked `serve`: everyone who comes through it is their tailnet login, and nobody gets in without one. Everyone in a thread sees who wrote each message, and who pressed Stop. List your own login in ade.json's `ownerLogins` (`["you@github"]`) and you're the owner on every device. Don't point Serve, a tunnel or a proxy at the first port; it turns away anything that came through one. An agent's commands run on a runner's machine too, but they never speak for you: on Linux the server sees what an agent ran on its own machine and lets it read, not write, owner key or not, and points it to its answer and the post tool. That's it.

Elsewhere, you're the owner with the owner key, which the server writes beside its data at first start (`owner.key`). `ade link` on the server's machine prints a link that brings a browser in with it; the CLI sends it when `ADE_OWNER_KEY` is set.

## Settings

Settings live in `~/.config/ade/ade.json` (or under `$XDG_CONFIG_HOME`), wherever you start. For example, to turn web search on and talk off:

```json
{
	"modules": ["+web-search", "-talk"]
}
```

Use `+` and `-` to change the defaults; a list of bare names replaces them. A name that matches no module in `modules/` gets a warning on start-up and is skipped, not a refusal to boot.

Threads live in `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite`, with its SQLite sidecars, lock and `ade.log` beside it. It's ade's database: Pi Durable keeps its records there, and with the `read` module on the `ade_` tables beside them hold the house as plain SQL. Settings stay in `${XDG_CONFIG_HOME:-~/.config}/ade/ade.json`. `DB_PATH` selects another store and puts its log beside it; it does not move settings.

Server secrets, like `TYPESAFE_API_KEY` and `MATRIX_TOKEN`, go in `${XDG_CONFIG_HOME:-~/.config}/ade/.env`, loaded at start-up if it exists; a variable already set in the shell wins over it.

The server's address, port, Serve port and data file come from the environment (`HOST`, `PORT`, `SERVE_PORT`, `DB_PATH`), and so can `MODULES`. These win over the file. `SERVE_PORT` is the first free one after `PORT` unless you set it; set it, so `tailscale serve` always finds it.
