# Security

Letting someone into your house means they can use every runner in it, yours included, and their agents run as you on your machines. On any shared runner, a friend can read anything your user there can: your SSH private keys, API keys in `.env` files, the owner key, browser sessions, your notes.

That's on purpose. Steering agents together is the point.

Owner-only controls are about who runs the settings. They're not a security line.

A machine that holds things you won't share gets `--owner`, which keeps its runner to yourself, or runs its runner as a separate OS user, or lives on a VPS.

Ade has no accounts and no hosted platform. You run it yourself, as the desktop app or as a Node server, and it trusts how a request arrived, never a name the request gives. There are two ways to have more than one person in a house: friends join your tailnet under their own login, or you invite them, each with a key of their own.

Ade has no sandbox. An agent runs commands as the user its runner runs as, so anyone who can give an agent work can do what that user can. Read the rest with that in mind.

## Who gets in

The server listens on two ports, both on this machine alone unless you set `HOST`. With invites off:

- The main port, 3000 unless taken. A request that comes straight from this machine, to a localhost name, with no proxy headers (`X-Forwarded-For`, `Forwarded`, `Tailscale-User-Login`), is the owner. Anything else here is nobody, so pointing Serve, a tunnel or a proxy at this port gets you turned away.
- The Serve port, the next free one, for `tailscale serve`. Whoever comes through it is the login Tailscale names in `Tailscale-User-Login`. No login, no entry. A login listed in ade.json's `ownerLogins` is the owner; any other is a guest under their own name.

The owner key works on either port, as a bearer token or the `HttpOnly`, `SameSite=Strict` cookie `ade link` sets up. Both listeners refuse a `Host` they don't answer to (DNS rebinding) and a write whose `Origin` isn't their own page. That's all of it: `whoSent` and `answersTo` in server.js.

With `HOST` set to a network address, the main port answers that network, but only the owner key gets anyone past it.

### Invites

Invites are a switch of their own, off by default: `"invites": true` in ade.json. Where the house listens doesn't change. With invites on, only keys get in, on every port: the owner key, and invites' keys. A tailnet login alone is nobody, and so is a request from the server's own machine without the owner key; the CLI and `ade runner` there send the key beside the store for you.

`ade invite sam` makes a key with sam's name on it and prints a link with the key after `#key=`. The page trades it for the same cookie the owner's link sets, and drops it from the address. Inviting sam again replaces the key. `ade uninvite sam` takes it back: from the next request it opens nothing, and sam's open sockets close. `ade invites` lists who holds one. Only the owner invites. The server keeps each key's SHA-256, never the key.

Turn invites on before you put a house where strangers can reach it. The server can't tell a tunnel from localhost, so it can't do that for you.

## What a guest can do

A guest, by tailnet login or by invite, is nearly the owner. They can't change settings, restart the server, remake the SQL tables, read a hook's secret, or see invites. They can see, write in, start and archive threads. They can make bots and schedule tasks, but only the owner or the bot's creator can change or forget it, and only the owner or whoever a task runs as can edit, cancel, pause, resume, move or run it early. Archiving a thread still ends its tasks.

That includes running commands, by design: everyone in your house can run agents on your machines as you. Who you let in, onto your tailnet or by invite, is the trust boundary. A runner takes work from anyone unless it was started with `--owner` (and `--allow`), and the server's own runner never is, so a guest can start a thread on your machine and have its agent run `rm -rf ~` as you. Keep a runner to yourself with `--owner`.

A guest can add a runner of their own, under a name no runner holds; it's shared like the rest, and runs everyone's agents as that guest's user. Only that guest gives it a new key; that guest or the owner revokes it. Nobody, the owner included, takes over a name another runner holds: a new key for a name goes only to whoever made it.

## Runners

A runner dials the server's socket and shows its key, `air_…`, as a bearer. The server keeps only the key's SHA-256, and turns away a wrong or revoked one. The runner saves its key in `~/.config/ade/key.<name>` (mode 600); the server's own runner gets its key from the server and keeps it in memory only. A new key for a name cuts off the runner that held the old one.

At connect, a runner says whom it takes work from (`--owner`, `--allow`) and whether it's `--read-only`, which refuses writes and commands. The server enforces the first; the runner enforces the second.

## Agents

An agent's commands inherit its runner's environment, minus `ADE_KEY`: the runner deletes it before any agent runs. Instead they carry `ADE_AGENT_OF`, the server they work for.

Since 6d4cc800, the server looks up who's on the other end of every write that arrives from this machine: it finds the process holding the socket in `/proc` and reads its environment. A process marked `ADE_AGENT_OF` for this server may read but not write, owner key or not, and is told to answer or use the post tool instead. Module sockets (the canvas) are refused to it outright. Agents still post, ask and schedule through their own tools, which the server runs for them. An agent can cancel tasks it set in that thread. A bot can change itself in its home thread, including when a guest asks it to.

## Off by default

- Invites, above. A public address is planned, not built ([roadmap](docs/roadmap.md)). Without invites, don't put a house on the open internet: anyone who reaches it could run commands on your runners.
- Hooks (`+hooks`) open a third listener, the only one meant for the internet: `POST /hooks/<task id>` and nothing else, with a secret per task, a size cap, a deadline and a cap on requests at once. Publishing it is yours to do, with `tailscale funnel` on a port of its own; ade never turns Funnel on.
- Matrix (`+matrix`) lets the people in `MATRIX_USERS` ask an agent from a Matrix room.

## Where secrets live

- `owner.key`, beside the store (`~/.local/share/ade/`), mode 600. Whoever reads the data folder is the owner, so a runner on the server's own machine lets anyone in the house make themselves owner.
- Invites and runner keys, as SHA-256 only, in the store.
- `~/.config/ade/.env`: server secrets like `TYPESAFE_API_KEY` and `MATRIX_TOKEN`, loaded at start-up.
- `~/.config/ade/key.<name>`: each runner's key, on the runner's machine.
- Model logins stay where pi keeps them, on each runner's machine. They never pass through the server.

## Known gaps

- The agent-write check is skin-deep. `env -u ADE_AGENT_OF curl -X POST …` from an agent's shell writes as the owner; so does any process the agent starts without the mark.
- It only exists on Linux. On macOS there's no `/proc`, and an agent's writes from the server's machine count as the owner's.
- It only sees this machine. An agent on another runner reaches the server through Serve as that machine's tailnet login, which is the owner if it's in `ownerLogins`.
- Agents run as their runner's user, so they can read `owner.key`, `.env`, runner key files and pi's logins on their machine. The `ADE_KEY` strip keeps the key out of their environment, not off the disk.
- Anything running as you on the server's machine is the owner, by design.
