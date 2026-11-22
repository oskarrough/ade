# API and CLI

Everything the page does, you can do with a few requests. You don't say who you are; the server knows from how you came in. From its own machine you're the owner, and anything that names someone else, an `x-user` header or a `?user=`, is ignored. Through its Serve port you're the login `Tailscale-User-Login` names, and a request without one is refused. Anywhere else, send the owner key from `owner.key` beside the store as `Authorization: Bearer <key>`. `GET /api/server` answers with `me`, the name your messages, read marks and drawings get. The owner's is `owner` in ade.json, or their login on the server's machine; set it to the name your history has, and it stays yours. A tailnet login listed in ade.json's `ownerLogins`, like `["oskar@github"]`, is the owner; any other is `~` and the login with `@` written as `+`, so it never reads as a bot or an agent.

```sh
api() { curl -s -H 'content-type: application/json' "localhost:3000/api/$1" ${2:+-d "$2"}; }

api threads '{"title": "hello"}' # → {"id": 3}
api threads/3/entries '{"body": "what machine is this?", "to": "sonnet@laptop"}'
api threads/3 # the thread and its messages so far
api threads/3/entries '{"body": "and now?", "to": "opus:high@laptop"}' # same agent, new model
api threads/3/fork '{"at": 5}' # a new thread from message 5
api threads/3/stop '{}'
```

A message's `to` says whom it asks: an agent like `sonnet@laptop`, a bot's name, or `null` for nobody. Leave it out in a group (the thread's agent plus bots, at least two) and the director picks who answers, or nobody; people don't count. The message is saved first and its pick lands after it, as a route entry (`ade.route`, `{message, to, picked}`) that reads and the socket show as that message's own `to` and `picked`; the POST still answers once the pick is in. An `@name` mention asks that bot for this message only; a bot that isn't in the thread yet joins, as if you'd picked it from the list. Failed picks ask the thread's agent and record the failure in `picked`; without a thread agent, nobody is asked. Solo chats and commands ask whoever the thread asked last. A body starting with `$ ` runs that command on the runner instead.

Stop ends every agent's and command's work in the thread. If anything was working, it writes a message from whoever pressed it, `stopped: true` with the body `stopped`: everyone sees who ended the run, it asks no one, and the agents read it with what they're handed next.

A message's `key`, 1 to 100 characters, dedupes it within its thread: a repeat with the same key returns the first message instead of posting again, even after a restart. It's scoped to the thread, so the same key in another thread is a different message; reused for a different body or `to` in the same thread, it still returns the first. Creating a thread takes the same `key`, scoped instead to thread creation, so the same text can't collide between the two. The CLI sends a fresh one with every post, so a retried request can't double it; a hook wake (`hooks`) keys each event by its delivery. The `matrix` module dedupes a different way, by the Matrix event id, inside the server, not through this field.

A bot that posts with its `post` tool into a thread it's in, or one it opens for other bots, speaks there as itself: its message carries `posted: true`, which marks it as an agent's, as `answer` does, so it never counts as a person's. Messages from before this have no mark.

A message its author takes back leaves a withdrawal entry (`ade.withdrawal`, `{message}`). Reads leave the message out; the socket sends it again as `{author, createdAt, body: '', withdrawn: true}`, so a page drops it, and an agent's memory keeps its place as "(took back a message)".

Every message carries `createdAt`, the ISO time the server wrote it; one brought in from a pi session keeps pi's time. Messages from before ade stamped them have none.

With the `inbox` module on, the agent's `ask_person({body})` tool posts a message with `waitingOnPerson: true`. Thread views and lists return `status: "blocked"` until a person's next message, even if agents keep writing. This takes precedence over live work and unread-answer status. It is derived from messages, not stored separately. The tool returns at once, so the agent may carry on or end its turn; the CLI's `post` and `wait` stop waiting once only the question is left. A thread's `busy` says whether it has work whatever its status shows: an agent answering or waiting for its runner, a `$` command, a director pick. With a question open and a command running, it's `blocked` and `busy`, and `wait` waits for the command.

To watch a thread live, open `/ws` and send `{"watch": 3}`. You get its newest messages, at least 15, with `earlier: true` when more lie before them, then new messages and each agent's work as it happens. `people`, who's in the thread, comes with the first messages and again only when it changes. Each agent's turns reach back only as far as the messages you have; its first batch carries `cut`, its newest compaction as `{id, model, first}` (the summary, and the first message it still reads whole), or `null`, and so does any batch with a new compaction; `{"changed": ["threads", "runners"]}` names the lists to fetch again, from `threads`, `archived`, `runners`, `bots`, `inbox` and `server`, which names a change to the client's files, so `GET /api/server` answers another `client`: a thread's change names the list it's in, and `inbox` only when a question is asked, answered or dismissed; work names `threads` and `runners` as it starts and ends, so a runner's `calls` are as of your fetch; after a reconnect, fetch them all, since you may have missed some. When a message's pick lands, the socket sends that message again with its `to` and `picked`; replace your copy. Modules also send `{thread, activity}` events as they work, kept nowhere: `{at, purpose, kind, …}`, where `kind: "call"` is a model call (`model`, `ms`, `tokens`, `outcome`: running, ok, error, timeout or stopped). The director's (`purpose: "director"`) add `message`, `mention`, `wait`, `hold` (with the `names` typing), `dropped` and `picked` (with its `confidence`), the last once the pick is saved. Send `{"earlier": 3}` for the page before the oldest you have, at least 50 messages, or `{"earlier": 3, "all": true}` for all of them: each agent's turns for it come first, then the messages, both marked `older: true`, the messages with `earlier` again.

```
GET    /api/server                     modules, settings, `me`, who the server takes you for, `client`, what a reload of the page gets,
                                       and `commit`, the checkout's commit (null for an install)
GET    /api/changes?since=<commit>     {commits}: the subjects of the commits since that one, newest first
POST   /api/me                         with the owner key as a bearer: keeps it as this browser's cookie
GET    /api/runners
POST   /api/runners {name}             a key, and the command that connects it
DELETE /api/runners/:name
GET    /api/runners/:name/available    every model pi is logged in for there; `offers` are its scoped ones
GET    /api/threads                    each thread's row; its `parent`, or `conversation.parent` for a fork, places it in a family
POST   /api/threads {title, parent?, tools?, key?}
GET    /api/threads/:id                its row, people and messages; `?last=n` only the newest n, `?after=id` only those after one
GET    /api/threads/archived
POST   /api/threads/:id/archive {archived}
POST   /api/threads/:id/entries {body, to?, images?, steer?, key?}
POST   /api/threads/:id/withdraw {entry}  takes back your message (its id) while no agent has read it: {withdrawn}, or an error once one has
POST   /api/threads/:id/fork {at, title?}
POST   /api/threads/:id/title {title}
POST   /api/threads/:id/tools {tools}  as pi --tools takes them
POST   /api/threads/:id/pause {paused}  only @mentions and named recipients get an answer while paused
POST   /api/threads/:id/typing {typing}  you're typing (a beat lasts 6 s) or stopped; the director's picks wait for it
POST   /api/threads/:id/read
POST   /api/threads/:id/stop
POST   /api/threads/:id/compact
GET    /api/conversations/:id          an agent's own conversation, tool calls and all
```

Modules add their own routes under `/api/<module>`. With `bots` on:

```
GET    /api/bots
POST   /api/bots {name, to?, instructions?, color?, rename?}   makes or changes a bot
DELETE /api/bots/:name
GET    /api/threads/:home/bots?asked=4,7   for a bot's home, each thread that asked her: `{thread, question, answer}`, its first message and her answer to it, or `null`
```

`rename` gives a bot a new name, under the same rules as a new one. It keeps its home, instructions, model and colour, and its agent in every thread it's in answers to the new name. Messages already written keep the old one, which asks no one now. A bot's home thread always shows the bot's name as its title, so it can't be renamed on its own.

`GET /api/bots` gives each bot an `answeredAt`: an ISO time, the newest message anywhere she answered (not only her home), or `null` if she never has.

A new bot starts with empty `instructions`; it writes its own with the `bot` tool, or you can set them directly. Every bot also reads one shared instruction, `bots.voice`, rendered just before its own: a chatty default until someone edits it in settings or `POST /api/settings {bots: {voice}}`, empty for none. `GET /api/server`'s `settings.bots.voice` gives the text in effect, default included.

With `recap` on:

```
GET    /api/threads/:id/recap       {page, through, writtenAt, writing}; `?open` says you're looking, which keeps it written
POST   /api/threads/:id/recap {fresh?}   writes it now, from scratch with `fresh`, and answers once it's written
```

The `page` is a checklist of at most six lines, one per topic, newest last. A line is `- [x] ` for done or `- [ ] ` for open, a sentence, then the messages behind it as `[#12](#message-12)`, counting from the thread's first message as 0:

```
- [x] Settled on SQLite over Postgres for one machine [#3](#message-3)
- [ ] Import still drops images from pi sessions [#14](#message-14) [#17](#message-17)
```

It never says whether something is running right now; a thread's `status` does.

With `memory` on:

```
GET    /api/threads/:id/memory?room=30   the memory view: bounds, the cut, and the lines above it, in one read
GET    /api/threads/:id/memory?zoom=id,n opens one line, as the agent's `zoom` does: {lines} or {message}
```

`room` goes from 0, the tightest cut, to 100, every line that fits 64 KB, growing geometrically between them. The answer is read from one copy of the thread's lines:

```
{
  total: 392,                  // messages
  least: 565, full: 65069,     // the bytes at room 0 and 100
  budget: 2347,                // the bytes at this room
  cut: [{id, n, text}],        // what the agent reads, oldest first
  tree: [{id, n, text, kind, children?}]
}
```

`tree` is the cut opened from the top: a line with `kind: 'cut'` is in the cut, one with `kind: 'above'` is written higher up and holds the cut's lines under it as `children`. A cut with unwritten messages, or one line for the whole thread, comes flat. Like opening the view, the read writes the message lines a thread that remembers is missing.

With `inbox` on:

```
GET    /api/inbox                       [{thread, question, asker}], newest first: each thread's open `ask_person` message, and the conversation of the agent that asked
POST   /api/threads/:id/inbox {dismiss}   hides that question (its message id) until the thread asks again; `{dismissed: null}` if it's no longer the open one
```

A question leaves the inbox once a person writes in its thread, the same moment the thread stops being blocked. A dismissed one stays blocked; it's only out of the inbox.

With `wake` on:

```
GET    /api/threads/:id/wake            [{id, at?, after?, every?, note, agent}]: the thread's pending wakes, timed ones soonest first, then those waiting on thread `after`
POST   /api/threads/:id/wake {cancel}   cancels that wake (its id): {cancelled}, or {fired} if a one-off went off first, {ended} if it had ended otherwise
```

A wake that fires posts `{author, body: note, wake: id, to: [author]}`: the agent that set it, asking itself. Each change to a thread's wakes (set, fired, cancelled) sends the pages watching it `{thread, activity: {purpose: "wake", kind: "changed"}}`; fetch its wakes again then, and after a reconnect.

With `hooks` on too, a wake can be `on` an outside event, and lists as `{id, on, note, agent}`. Outside `/api`, the hook takes no owner key or login, only its own secret:

```
POST   /hooks/:id                       an event for wake :id, with `Authorization: Bearer <secret>`, or signed with it as GitHub does (X-Hub-Signature-256): {woke}, {repeat} for one it posted already, {ignored} for one it doesn't wait for; 403 for a wrong secret, 404 once it's cancelled
```

`on: "hook"` takes any body, up to a megabyte, and posts its first 2000 characters after the note. `push` and `ci` take GitHub's JSON: a push, and a workflow run or check suite that completed with `failure` or `timed_out`; any other event, its ping included, is `ignored`. A repeat is the same `X-GitHub-Delivery`, else the same `Idempotency-Key` header, else the same body; it posts once, as a message with the same `key` does.

With `export` on:

```
GET    /api/export   {files}, every thread's files, archived ones included, as a map of file name to its text:
                       one Markdown file and one JSON file per thread; nothing is written anywhere
```

Each JSON file holds a thread's entries exactly as `GET /api/threads/:id` returns them. Its Markdown file is for a
person: the title, who wrote in it, then each message as "**author** · time" with the body; a `$ cmd` message's
shell result folds into one line. Both read without ade installed, and the route reaches a server anywhere, not
only its own machine; `node cli.js export <dir>` fetches it and writes the files.

The routes are in `server.js`, the runner protocol in [remote.js](../remote.js).

The CLI is the same API from a terminal:

```sh
node cli.js post "hello" --to sonnet@laptop    # prints the answer as it lands
node cli.js threads
node cli.js read 3
node cli.js wait 3                             # waits for its agents, then prints the answers
node cli.js stop 3
node cli.js export ~/backup                    # with export on: every thread as Markdown and JSON
```

It writes as whoever the server takes it for: on the server's machine, the owner, an agent's shell there included. Against a server elsewhere (`--server` or `ADE_SERVER`), set `ADE_OWNER_KEY` to write as the owner; through a Serve address you're your tailnet login without it. `node cli.js link`, on the server's machine, prints a link that brings a browser in as the owner.

A new thread prints `thread N` on stdout, followed by any answers; progress and errors go to stderr. To capture just its id without waiting:

```sh
thread=$(node cli.js post "hello" --to sonnet@laptop --no-wait)
node cli.js wait "${thread#thread }"
```

`node cli.js --help` has the rest.

## Server settings

The server's address and data path are set in the environment, not in `ade.json`:

```sh
PORT=3001 npx github:oskarrough/ade     # a fixed port; otherwise the first free one from 3000
DB_PATH=other.sqlite npx github:oskarrough/ade
```

These win over the file; leave them unset to choose from the page.

```sh
MODULES=+web-search,-talk npx github:oskarrough/ade
MEMORY_MODEL=sonnet@laptop npx github:oskarrough/ade
```

From a clone, use `node server.js` in place of `npx github:oskarrough/ade`.

Threads and conversations live in `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite`, with its `-wal`, `-shm`, `.lock` and the server's output in `ade.log` beside it. Every folder you start in sees the same threads. Settings stay in `${XDG_CONFIG_HOME:-~/.config}/ade/ade.json`. `DB_PATH=other.sqlite` selects another store and logs to `other.log` beside it; it does not move settings.

`--no-runner` starts the server without connecting this machine as a runner.
