# API and CLI

Everything the page does, you can do with a few requests. Say who you are with `x-user`:

```sh
api() { curl -s -H 'x-user: oskar' -H 'content-type: application/json' "localhost:3000/api/$1" ${2:+-d "$2"}; }

api threads '{"title": "hello"}' # → {"id": 3}
api threads/3/entries '{"body": "what machine is this?", "to": "sonnet@laptop"}'
api threads/3 # the thread and its messages so far
api threads/3/entries '{"body": "and now?", "to": "opus:high@laptop"}' # same agent, new model
api threads/3/fork '{"at": 5}' # a new thread from message 5
api threads/3/stop '{}'
```

A message's `to` says whom it asks: an agent like `sonnet@laptop`, a bot's name, or `null` for nobody. Leave it out in a group (the thread's agent plus bots, at least two) and the director picks who answers, or nobody; people don't count. The message is saved first and its pick lands after it, as a route entry (`ade.route`, `{message, to, picked}`) that reads and the socket show as that message's own `to` and `picked`; the POST still answers once the pick is in. An `@name` mention asks that bot for this message only. Failed picks ask the thread's agent and record the failure in `picked`; without a thread agent, nobody is asked. Solo chats and commands ask whoever the thread asked last. A body starting with `$ ` runs that command on the runner instead.

Every message carries `createdAt`, the ISO time the server wrote it; one brought in from a pi session keeps pi's time. Messages from before ade stamped them have none.

With the `blocked` module on, the agent's `ask_person({body})` tool posts a message with `waitingOnPerson: true`. Thread views and lists return `status: "blocked"` until a person's next message, even if agents keep writing. This takes precedence over live work and unread-answer status. It is derived from messages, not stored separately. The tool returns at once, so the agent may carry on or end its turn; the CLI's `post` and `wait` stop waiting once only the question is left.

To watch a thread live, open `/ws` and send `{"watch": 3}`. You get its newest messages, at least 15, with `earlier: true` when more lie before them, then new messages and each agent's work as it happens. Each agent's turns reach back only as far as the messages you have; its first batch carries `cut`, its newest compaction as `{id, model, first}` (the summary, and the first message it still reads whole), or `null`, and so does any batch with a new compaction; `{"changed": ["threads", "runners"]}` names the lists to fetch again, from `threads`, `archived`, `runners`, `bots` and `inbox`: a thread's change names the list it's in, and `inbox` only when a question is asked, answered or dismissed; after a reconnect, fetch them all, since you may have missed some. When a message's pick lands, the socket sends that message again with its `to` and `picked`; replace your copy. Modules also send `{thread, activity}` events as they work, kept nowhere: `{at, purpose, kind, …}`, where `kind: "call"` is a model call (`model`, `ms`, `tokens`, `outcome`: running, ok, error, timeout or stopped). The director's (`purpose: "director"`) add `message`, `mention`, `wait`, `dropped` and `picked`, the last once the pick is saved. Send `{"earlier": 3}` for the page before the oldest you have, at least 50 messages, or `{"earlier": 3, "all": true}` for all of them: each agent's turns for it come first, then the messages, both marked `older: true`, the messages with `earlier` again.

```
GET    /api/server                     modules, settings
GET    /api/runners
POST   /api/runners {name}             a key, and the command that connects it
DELETE /api/runners/:name
GET    /api/runners/:name/available    every model pi is logged in for there; `offers` are its scoped ones
GET    /api/threads                    each thread's row; its `parent`, or `conversation.parent` for a fork, places it in a family
POST   /api/threads {title, parent?, tools?}
GET    /api/threads/:id
GET    /api/threads/archived
POST   /api/threads/:id/archive {archived}
POST   /api/threads/:id/entries {body, to?, images?, steer?}
POST   /api/threads/:id/fork {at, title?}
POST   /api/threads/:id/title {title}
POST   /api/threads/:id/tools {tools}  as pi --tools takes them
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

With `blocked` and `inbox` on:

```
GET    /api/inbox                       [{thread, question}], newest first: each thread's open `ask_person` message
POST   /api/threads/:id/inbox {dismiss}   hides that question (its message id) until the thread asks again
```

A question leaves the inbox once a person writes in its thread, the same moment the thread stops being blocked. A dismissed one stays blocked; it's only out of the inbox.

With `wake` on:

```
GET    /api/threads/:id/wake            [{id, at, every?, note, agent}], soonest first: the thread's pending wakes
POST   /api/threads/:id/wake {cancel}   cancels that wake (its id)
```

A wake that fires posts `{author, body: note, wake: id, to: [author]}`: the agent that set it, asking itself.

The routes are in `server.js`, the runner protocol in [remote.js](../remote.js).

The CLI is the same API from a terminal:

```sh
node cli.js post "hello" --to sonnet@laptop    # prints the answer as it lands
node cli.js threads
node cli.js read 3
node cli.js wait 3                             # waits for its agents, then prints the answers
node cli.js stop 3
```

Run from an agent's own shell, `post` writes as that agent (its model and thinking, like `sonnet:high`), whatever its model; anywhere else it writes as you.

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
