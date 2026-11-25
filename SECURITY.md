# Security

Letting someone into your house means they can use every runner in it, yours included, and their agents run as you on your machines. On any shared runner, a friend can read anything your user there can: your SSH private keys, API keys in `.env` files, the owner key, browser sessions, your notes.

That's on purpose. Steering agents together is the point.

Owner-only controls are about who runs the settings. They're not a security line.

A machine that holds things you won't share gets `--owner`, which keeps its runner to yourself, or runs its runner as a separate OS user, or lives on a VPS.

Ade has no accounts and no hosted platform. You run it yourself, as the desktop app or as a Node server, and it trusts how a request arrived, never a name the request gives. Ade has no sandbox.

## Who gets in

With invites off, the default:

- You, the owner, on the server's own machine, or anywhere with the owner key.
- Anyone on your tailnet, through `tailscale serve`, as their tailnet login. A login listed in ade.json's `ownerLogins` reads as you, and writes as you once that device holds the owner key (see Agents below).

With invites on (`"invites": true` in ade.json), it's invite-only: everyone needs a key, tailnet friends included. You use the owner key; the desktop app and the CLI on the server's machine send it for you, `ADE_OWNER_KEY` carries it elsewhere, and `ade link` prints a link that brings a browser in with it. `ade invite sam` gives sam a key, `ade uninvite sam` takes it back, `ade invites` lists them. Settings' People does the same from the page: turning invites on there keeps the owner key in that browser, and it gives the owner link for your other devices.

A public address, or a tunnel other than Tailscale, isn't built or supported.

## What they can do

Everyone in the house, owner and guests alike, shares every runner, the server's own included, and can read whatever that runner's user can, the owner key too. Start a runner with `--owner` to keep it to yourself.

Guests can't change settings, restart the server, remake the SQL tables, see invites or read a hook's secret. Anyone can make bots and scheduled tasks; only the owner or a bot's maker changes or forgets it, and only the owner or whoever a task runs as edits, cancels, pauses, resumes, moves or runs it early. Archiving a thread ends its tasks.

A guest can add a runner of their own, under a name no runner has had. It's shared like the rest and runs everyone's agents as that guest's user. Only its maker gives it a new key; its maker or the owner revokes it. Names never change hands, even once revoked, and the server's own runner and every runner the owner made are the owner's.

## Agents

An agent never writes as the owner, on any runner. It posts, asks and schedules through its tools; what its shell sends the house may read, and writes nothing as you.

- On the server's machine, a runner marks its agents' commands with `ADE_AGENT_OF`, the server they work for. On Linux the server finds the process behind each write from this machine in `/proc`; one so marked may read but not write, owner key or not, and module sockets refuse it.
- Through Serve, Tailscale names a device's user, not the process, so an agent on your laptop comes in with your login. A login in `ownerLogins` alone therefore only reads as you. To write, a device shows the owner key: a browser keeps it as a cookie after opening the owner link once (Settings' People, or `ade link`), and the CLI sends `ADE_OWNER_KEY`.
- A runner strips `ADE_KEY` and `ADE_OWNER_KEY` from what its agents run.

A bot can change itself in its home thread, including when a guest asks it to.

## How the server decides

The rest is for whoever changes the code: `whoSent` and `answersTo` in server.js.

- The main port, 3000 unless taken, lets in the owner: a request straight from this machine, to a localhost name, with no `X-Forwarded-For`, `Forwarded` or `Tailscale-User-Login`. Anything through a proxy is nobody here. With `HOST` set to a network address, only the owner key gets past it.
- The Serve port, the next free one or `SERVE_PORT`, takes the login in `Tailscale-User-Login`. No login, no entry. An owner login without the owner key reads but doesn't write (`ownerByLogin`).
- The owner key works on either, as a bearer or the `HttpOnly`, `SameSite=Strict` cookie `POST /api/me` sets, or the settings save that turns invites on. With invites on, only the owner key and invite keys count, on both ports.
- Both refuse a `Host` they don't answer to (DNS rebinding) and a write whose `Origin` isn't their own page.

An invite link carries its key after `#key=`; the page trades it for the cookie and drops it from the address. A link whose key opens nothing, or a browser whose invite was taken back, gets a page that says so and nothing else. Inviting someone again replaces their key and closes what the old one opened. Uninviting works from the next request: the key opens nothing, their sockets close, their runners' keys go and the tasks that run as them end. An invite under the owner's name opens nothing.

A runner shows its key, `air_…`, as a bearer, and keeps it in `~/.config/ade/key.<name>` (mode 600); the server's own runner holds its key in memory only. A new key for a name cuts off the old one. The server enforces `--owner` and `--allow`; the runner enforces `--read-only`, which refuses writes and commands.

Hooks (`+hooks`, off by default) open a third listener, the only one meant for the internet: `POST /hooks/<task id>` and nothing else, with a secret per task and caps on size, time and load. Publishing it with `tailscale funnel` is yours to do; ade never turns Funnel on. Matrix (`+matrix`, off by default) lets the people in `MATRIX_USERS` ask an agent from a room.

## Where secrets live

- `owner.key`, beside the store (`~/.local/share/ade/`), mode 600.
- Invite and runner keys, as SHA-256 only, in the store. A retried request gets its key again by deriving it from the owner key.
- `~/.config/ade/.env`: server secrets like `TYPESAFE_API_KEY` and `MATRIX_TOKEN`.
- `~/.config/ade/key.<name>`: each runner's key, on its machine.
- Model logins stay where pi keeps them, on each runner's machine, and never pass through the server.

## Known gaps

- The check on the server's machine is skin-deep: `env -u ADE_AGENT_OF curl -X POST …` from an agent's shell there writes as the owner.
- It only exists on Linux; on macOS an agent's writes from the server's machine count as the owner's.
- An agent on a friend's machine comes through Serve as that friend.
- Stripping keys keeps them out of an agent's environment, not off the disk: an agent that reads `owner.key`, a browser's cookies or a shell profile exporting `ADE_OWNER_KEY` can write as you.
