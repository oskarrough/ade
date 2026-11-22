# Roadmap: ade and arbe as one app

ade and arbe become one app, with ade's code. arbe stops where it is: nothing migrated, its repo a parts bin, its docs the record of decisions. The name arbe comes along once someone else runs it.

## What we believe

A house is one server and the runners connected to it. Everyone inside is trusted. That one rule is what keeps everything else simple: no locks inside, no per-person permissions, no sandboxes. Anyone in the house can ask any agent to run commands on any runner, same as you.

So the protection is the door, and where you put the house:

- Localhost: only you get in.
- Your tailnet: your devices, and whoever you share it with.
- A public address, through a tunnel or a VPS: anyone who has it.

Invites are a switch any house can turn on, wherever it stands: an invite is a key with their name on it that you can take back. Turn it on before you go public; the server can't tell a tunnel from localhost, so it can't do that for you. A public house without invites lets anyone on the internet run commands on your runners. That's yours to choose, say for a demo whose runners hold nothing.

The owner is whoever can read the server's data folder. At first start the server writes an owner key there, beside the runner keys; anything run on that box reads it, so `arbe invite sam` just works, and `arbe open` prints a link that brings your browser in with it. Localhost counts as the owner only while invites are off. Once they're on, everyone comes in with a key, you too.

A runner is a machine you hand to everyone in the house. Put one on the laptop with your notes and SSH keys only in a house that's just yours. A runner on the server's own box can read the owner key, so anyone in the house can make themselves owner through it: keep runners off that box, or accept it.

The rest follows:

- arbe is `node server.js` on your own box: a laptop, a laptop with a tunnel, or a VPS. We never hold anyone's stuff. If arbe ever offers a service, it's a door, never a house: a relay that gives your laptop a public address, or a button that puts arbe on your own server.
- No accounts, not even for whoever pays.
- One server is one house. Want two? Run two servers. Moving a server moves the house: stop, copy, start. Nothing syncs between places.
- Owner-only controls are about who runs the settings, not safety.
- It's for someone who runs a server and the friends they bring. That's a choice of audience, and it's not free: a team that just wants it to work isn't served.

## Steps

Each step is who's there, the question it answers, and the smallest thing that makes it possible.

### 1. Me

What we have. I live in it.

### 2. Others

Friends in my house. The question: does steering agents together in one thread work when several people are in it, who's talking, who the director answers, nobody stepping on anyone?

The smallest thing it needs is the server knowing who's talking: a message's author comes from how the request arrived (the owner key, or localhost while invites are off; the tailnet login), never from a name the client sends. Friends join through the tailnet: Tailscale's node sharing lets me add people from outside my own, and the server knows who's who from their login. Done apart from the test with a real friend, not a simulation.

Inviting someone shows every runner in the house and whose machine each one is. Guests see the same list. No runner-side setting: a runner only joins a house its owner gave it the key to.

Later, once a second person's machine is in the house: when someone new joins, that machine's owner gets a note with one click to take their machine out.

The director, the part that picks who answers, becomes one director made from arbe's and ade's, which works well in arbe.

### 3. Not me

Someone else runs their own, without my help. The question: is it really portable? The one-command install and the export that writes every thread out as Markdown or JSON, readable without ade installed, are both done.

Left: invites and a public address. Both may get built, but stay switched off until someone needs them. The rename to arbe is parked.

The test: a friend gets the install instructions and their data file and gets running without my help. It passes only if they can also leave: export, shut the server down, and still have their threads.

No hosted pilot. Hosting versus audience comes back up only if people still won't set up a server once it's easy.

## Waking a thread

One primitive: wake a thread when something happens, without anyone posting to it, built on Pi Durable's stored sleeps and signals. Three triggers. A time: an agent scheduling itself ("check CI in 5 minutes") or a recurring routine. Another thread finishing: a review that opens once its fix lands, the dependency idea from Vercel Board. An outside event, the last and optional piece: a push or an email, with MCP Events one possible source. arbe's scheduler is the reference to port from.

All three have landed. A time and another thread finishing are the `schedule` module: `schedule({instructions, in, every, repeat, time})`, a background stored sleep per scheduled task that posts the instructions back to its agent, by the clock if asked, survives restarts and Stop, and shows above the composer with pause and × ; a person sets one from the Scheduled tasks list. `schedule({after: N, instructions})` sleeps on a signal the module sends once thread N has no work left, when the server hears that thread's last work task end, archived or not, and on start; it fires at once if N is already idle. Outside events are the `hooks` module, off by default and never published.

## Parts bin

From arbe, each as a module when a step misses it, not before: limits per thread ([capabilities](https://arbe.0sk.ar/docs/thinking/capabilities/)), shared files ([files](https://arbe.0sk.ar/docs/files/)), secrets kept out of the model's context ([secrets](https://arbe.0sk.ar/docs/system/access/secrets/)), rented sandboxes as runners ([environments](https://arbe.0sk.ar/docs/system/sandboxes/environments/)), usage ([usage & cost](https://arbe.0sk.ar/docs/usage-cost/)), teams ([teams](https://arbe.0sk.ar/docs/system/access/teams/)), and the CLI's best commands ([CLI](https://arbe.0sk.ar/docs/cli/)).

Search has landed ([thread search](https://arbe.0sk.ar/docs/system/chat/thread-search/)). Workflows ([workflows](https://arbe.0sk.ar/docs/workflows/)) start as bot recipes on scheduled tasks — Lens, Dawn, Sitter — and the house-wide Scheduled tasks list.
