# API and CLI

Everything the page does, you can do with a few requests. You don't say who you are; the server knows from how you came in ([SECURITY.md](../SECURITY.md)), and ignores an `x-user` header or a `?user=`. On its own machine you're the owner. Through the Serve port you're the login in `Tailscale-User-Login`; the owner's login only reads until it shows the owner key, and a write without it answers 403 with `needs: "owner-key"`. The owner's `owner.key` beside the store works anywhere as `Authorization: Bearer <key>`. With invites on, only that key or an invite's gets you in. `GET /api/server` answers with `me`, the name your messages, read marks and drawings get. The owner's is `owner` in ade.json, or their login on the server's machine; set it to the name your history has, and it stays yours. A tailnet login that isn't the owner's is `~` and the login with `@` written as `+`, so it never reads as a bot or an agent.

```sh
api() { curl -s -H 'content-type: application/json' "localhost:3000/api/$1" ${2:+-d "$2"}; }

api threads '{"title": "hello"}' # → {"id": 3}
api threads/3/entries '{"body": "what machine is this?", "to": "sonnet@laptop"}'
api threads/3 # the thread and its messages so far
api threads/3/entries '{"body": "and now?", "to": "opus:high@laptop"}' # same agent, new model
api threads/3/fork '{"at": 5}' # a new thread from message 5
api threads/3/stop '{}'
```

A message's `to` says whom it asks: an agent like `sonnet@laptop`, a bot's name, or `null` for nobody. Leave it out in a group (the thread's agent plus bots, at least two) and the director picks who answers, or nobody; people don't count. The message is saved first and its pick lands after it, as a route entry (`ade.route`, `{message, to, picked}`) that reads and the socket show as that message's own `to` and `picked`; the POST answers as soon as the message is saved, with `direct: true` and an empty `to`, and whoever needs the pick waits for its route on the socket. An `@name` mention asks that bot for this message only; a bot that isn't in the thread yet joins, as if you'd picked it from the list. Failed picks ask the thread's agent and record the failure in `picked`; without a thread agent, nobody is asked. Solo chats and commands ask whoever the thread asked last. A body starting with `$ ` runs that command on the runner instead.

Stop ends every agent's and command's work in the thread. If anything was working, it writes a message from whoever pressed it, `stopped: true` with the body `stopped`: everyone sees who ended the run, it asks no one, and the agents read it with what they're handed next.

A message's `key`, 1 to 100 characters, dedupes it within its thread: a repeat with the same key returns the first message instead of posting again, even after a restart. It's scoped to the thread, so the same key in another thread is a different message; reused for a different body or `to` in the same thread, it still returns the first. Creating a thread takes the same `key`, scoped instead to thread creation, so the same text can't collide between the two. The CLI sends a fresh one with every post, so a retried request can't double it. The `matrix` module dedupes a different way, by the Matrix event id, inside the server, not through this field.

What you're writing in a thread is a draft on the server, yours alone: `{key, text, images, pick}`, where `pick` is whatever the page chose to ask next (an object, or `null`) and `key` is the key its message will be posted with. `POST /api/threads/:id/draft {key, text?, images?, pick?, page?}` saves it as you type: the fields you send replace the ones kept, so a page sends its text half a second after the typing pauses and its images only when they change. Posting the message with the draft's `key` empties the draft in the same commit, so a reload right after Send, or another device, never finds it again. A save under a key that was already sent changes nothing and answers `{draft: null, sent: true}`, so a save that was on its way when Send went can't bring it back, and posting again under that key returns the first message. The feed's `draft/<id>` (and `draft/new`) is yours alone, one row: `{draft, page}` after a save, with the `page` you sent so the one that saved can skip its own, and `{draft: null, sent: key}` once a message went under that key. A fork starts you with the pick you had in the thread you forked. `GET /api/threads/:id/draft` answers `{draft}`, `null` once it holds nothing.

A thread you haven't started has a draft too, one per person, at `GET` and `POST /api/draft`, the same way; every page of yours hears it change on `draft/new` as `{draft, page}`. Sending it makes the thread and its first message in one step: `POST /api/threads {title, key, body, to?, images?, steer?}` creates the thread and posts the message in one commit, answering `{id, entry, to}`, so there's never a thread without the message it was made for. The message asks whom `to` names and any bots it @mentions; a body starting `$ ` runs that command. Under the new-thread draft's key, the same commit empties that draft but for its pick, kept under no key for the next thread, and its pages hear `{draft, sent: key}` on `draft/new`. A save under a key a thread was already made with does nothing and answers `sent`, and sending again under it returns the first thread and message.

An agent's answer shows images the way a person's message does. Each `![](path)` in it, a png, jpeg, gif, webp or bmp on the agent's machine (`~` is the runner's home, a relative path its folder), is read through its runner, shrunk to pi's 2000×2000 and 4.5 MB like the read tool's, and becomes one of the message's `images`, up to 8; the body keeps the words around it. One it can't show stays in the body as `(couldn't show path: why)`. An answer back to an asking thread carries the images too, so the asker sees them.

A thread's messages, from `GET /api/threads/:id` and the feed's `thread/<id>`, name their images rather than carry them: each is `{type, mimeType, url, width, height}`, its size as the page shows it, so its place is held before it loads. `GET` its `url` for the bytes; a message never changes, so a browser keeps them for good and fetches each only when it scrolls into view. Drafts and the export keep the bytes, and agents are handed the images themselves.

A bot that posts with its `post` tool into a thread it's in, or one it opens for other bots, speaks there as itself: its message carries `posted: true`, which marks it as an agent's, as `answer` does, so it never counts as a person's.

A message its author takes back leaves a withdrawal entry (`ade.withdrawal`, `{message}`). Reads leave the message out; the feed removes its message id with `del`, and an agent's memory keeps its place as "(took back a message)".

Every message carries `createdAt`, the ISO time the server wrote it; one brought in from a pi session keeps pi's time.

Every message returned by `GET /api/threads/:id`, `GET /api/export` or the `/ws` feed arrives already shaped for the viewer asking:

- `speaker`: who spoke (`data.author`)
- `showName`: whether the speaker's name should show above this message (true when the speaker changed from the last non-viewer speaker, after an hour gap, after a crossed row or scheduled run, or when `to` names a reply target)
- `voice`: the row kind — `mine` (the viewer's own message), `said` (written here by someone else), `sent` (`→` cross-thread answer back to another thread), `received` (`←` cross-thread message from another thread), `run` (a scheduled task's fold), or `stopped` (who pressed Stop)
- `to`: in a group thread, the person an agent's answer replies to when it isn't the message right above or the newest message someone wrote
- `otherAuthor`, `otherThread`, `otherLabel`: for `sent` and `received` rows, the far side's author, thread id and display label
- `clamp`: true when written by a person or by the viewer; `failed`: true on an error; `picked` and `pickedNobody`: the director's pick summary when present

Successful API writes (`POST` and `DELETE`), except the cookie exchange at `/api/me`, include `seq` and `boot` in their JSON response: the feed's version and boot id once that write's commit was published. Passing `key` (or `?key=` on `DELETE`) on runners, bots, archive, title and inbox dismiss makes those writes idempotent, the same way posting and thread creation are.

With the `inbox` module on, the agent's `ask_person({body})` tool posts a message with `waitingOnPerson: true`. Thread views and lists return `status: "blocked"` until a person's next message, even if agents keep writing. This takes precedence over live work and unread-answer status. It is derived from messages, not stored separately. The tool returns at once, so the agent may carry on or end its turn; the CLI's `post` and `wait` stop waiting once only the question is left. A thread's `busy` says whether it has work whatever its status shows: an agent answering or waiting for its runner, a `$` command, a director pick. With a question open and a command running, it's `blocked` and `busy`, and `wait` waits for the command.

Everything a page hears from the server comes over one versioned feed on `/ws`. Subscribe with `{"sub": "<view>", "after": <seq?>, "boot": "<boot?>"}`, unsubscribe with `{"unsub": "<view>"}`, or ask to catch up to a write's version with `{"sync": "<view>", "seq": <seq>}`. Views are `server`, `runners`, `bots`, `inbox`, `threads`, `archived`, `schedule`, `schedule/<id>`, `recap/<id>`, `memory/<id>?room=<n>`, `usage?since=<ms>&zone=<ms>`, `usage/<id>?since=<ms>`, `thread/<id>`, `agents/<id>`, `trail/<id>`, and your own `draft/<id>` and `draft/new`. The server sends ordered envelopes:

```json
{
	"view": "threads",
	"boot": "9f2a...",
	"seq": 48211,
	"reset": true,
	"put": [
		{
			"key": 170311,
			"seq": 48207,
			"row": { "id": 170311, "title": "...", "status": "done", "unread": true, "latest": 170342 }
		}
	],
	"del": [170200]
}
```

`reset: true` is the full bootstrap (and what a reconnect gets after a restart, mismatched `boot`, or eviction); later updates send only changed rows in `put` and removed keys in `del`, and a reconnect with `after` and the current `boot` gets only what changed since that `seq`. In `threads`, each row's `latest` is the id of its newest message (its own id until it has one), so thread rows sort by latest activity; each family's root row carries `family: [{id, depth}, ...]` and descendants carry `root`. In `bots`, each row carries its server-computed `color`, `defaultColor`, `customColor`, `working` and `status`. In `thread/<id>`, key `"thread"` holds the thread's row, `people` and `earlier`, and integer entry ids hold the shaped messages (the newest 15 on bootstrap, then every new message as `put`, a later director pick as a `put` of the same key, and a withdrawal as a `del`).

In `agents/<id>`, each of the thread's agents has three kinds of row, keyed by its conversation: `<agent>/live`, what it does now as `{run, message, tools, delivery}` (the message it's writing, each tool call with its `args`, and the delivery it answers with the messages it `held`); `<agent>/cut`, its newest compaction as `{id, model, first}` (the summary, and the first message it still reads whole), or `null`; and `<agent>/<entry id>`, each conversation entry, as far back as the thread's newest page, an image in it without its bytes. `agents/<id>?from=<message id>` reaches back to that message's turns instead, and `?from=0` to all of them. In `trail/<id>`, the thread's newest 200 trail steps, keyed by `id`, each as `GET /api/threads/:id/trail` gives it. Fetch earlier messages with `GET /api/threads/3?before=<id>&last=50`, and subscribe to `agents/3?from=<its oldest id>` for their agents' turns.

```
GET    /api/server                     modules, settings, `me`, who the server takes you for, `client`, what a reload of the page gets,
                                       and `commit`, the checkout's commit (null for an install)
GET    /api/changes?since=<commit>     {commits: [{subject, at}]}: the commits since that one, newest first; without
                                       `since`, the newest 20; an installed release gives its release notes instead
POST   /api/me                         with the owner key or an invite's as a bearer: answers {me} and keeps it as this browser's cookie
POST   /api/link                       the owner's: {link}, the owner key as a link, to bring another device in
GET    /api/invites                    the owner's: {on, invites: [{name, at}]}
POST   /api/invites {name}             the owner's: {name, key, link, on}, a key with that name on it; again, a new one
DELETE /api/invites/:name              the owner's: from the next request the key opens nothing, their sockets close, their runners'
                                       keys go and the scheduled tasks that run as them end
POST   /api/restart                    the owner’s: {restarts}, whether the server starts again in place or stops
POST   /api/update                     the owner’s: stages the newest release and restarts if one is staged; 409 from a checkout
GET    /api/read                       the SQL tables’ state and row counts; `?check` compares them with the store
POST   /api/read {rebuild: true}       the owner’s: starts rebuilding those tables
GET    /api/runners
POST   /api/runners {name}             a key, and the commands that connect it: `ade` with ade, `connect` without; a name another's
                                       runner holds is refused. A guest's runner lists `by`, them
DELETE /api/runners/:name              its maker's or the owner's; the name stays its maker's
GET    /api/runners/:name/available    every model pi is logged in for there, as a list of names; the runner row’s `offers` are its scoped ones
GET    /api/threads                    each thread's row; its `parent`, or `conversation.parent` for a fork, places it in a family
POST   /api/threads {title, parent?, tools?, key?, body?, to?, images?, steer?, checkout?}  with a body, its first message in the same commit; `checkout: "own"` puts its agent in a checkout of its own (`checkouts`)
POST   /api/threads/shed {key?}        makes the walkthrough’s thread and messages: {id}
GET    /api/draft                      {draft}: yours for a thread not started yet, or null
POST   /api/draft {key, text?, images?, pick?, page?}  saves it, as a thread's draft saves
GET    /api/threads/:id                its row, people and its newest 50 shaped messages, with `earlier` when there are more; `?last=n` newest n, `?before=id&last=n` the page before one, `?after=id` those after one, `?all` every message
GET    /api/threads/archived
POST   /api/threads/:id/archive {archived}
POST   /api/threads/:id/entries {body, to?, images?, steer?, key?}
POST   /api/threads/:id/withdraw {entry}  takes back your message (its id) while no agent has read it: {withdrawn}, or an error once one has
POST   /api/threads/:id/fork {at, title?}  your pick from this thread comes with you
GET    /api/threads/:id/draft          {draft}: yours, or null
GET    /api/threads/:id/images/:entry-:n  that message's nth image, its bytes
POST   /api/threads/:id/draft {key, text?, images?, pick?, page?}  saves what you're writing; {draft}, or {draft: null, sent: true} once its key was sent
POST   /api/threads/:id/title {title}
POST   /api/threads/:id/tools {tools}  a nonempty list of tool names, or null to reset
POST   /api/threads/:id/pause {paused}  only @mentions and named recipients get an answer while paused
POST   /api/threads/:id/move {conversation, runner}  moves that agent in place to another runner: its model and thinking there, its folder starting over; what it waits to answer goes with it
POST   /api/threads/:id/typing {typing}  you're typing (a beat lasts 6 s) or stopped; the director's picks wait for it
POST   /api/threads/:id/read
GET    /api/threads/:id/trail          what happened, step by step, oldest first; `?entry=id` that message's story only
POST   /api/threads/:id/stop
POST   /api/threads/:id/compact
GET    /api/conversations/:id          an agent's own conversation, tool calls and all
```

### The trail

A thread's trail is what happened in it, one step at a time, like Temporal's event history. Each step is written in the same commit as what it records, as an `ade.trail` entry in a conversation the thread keeps for its trail, so a restart can't lose it and reading the thread's messages never reads it. `GET /api/threads/:id/trail` answers the newest 200 steps, oldest first; `?entry=<message id>` answers that message's story whole. `ade trail N` prints the same, and `--message id` one story. Each step is `{id, thread, entry, at, kind, text, …}`: `entry` the message it's about, `at` epoch milliseconds, `text` the step as a plain line, and by `kind`:

- `fired` `{task, instructions, schedule, recipients, runner?, check?}`: a scheduled task posted this message, with the task as it stood for this run, edits included: what it said, when it runs, whom it asked, the runner of one that starts a thread each run, and a hash of its check script, so two runs compare without replaying its edits; `skipped` `{task, why}`, with no `entry`: a run it skipped, or the one that ended it; `ended` `{task, why}`, with no `entry`: it ended by itself, its runs done or its end time come, or its check said done; `checked` `{task, said?}` or `{task, failed}`, with no `entry`: a run whose check asked no one, with the first line it printed, or whose check failed
- `posted` `{author, to, direct?, picked?}`: a message to whom; `direct` when the director picks
- `waited` `{ms, held?}`: the director's quiet before its pick, `held` when someone's typing kept it waiting
- `picked` `{to, picked?, over?, chose?}`: whom the pick asks. `chose` is how it chose: `{model, outcome, ms, waited, choice, confidence, candidates, read}`, `read` the ids of the messages it read, or `error` when it failed; `over` when the author's next message took over
- `started`, `answered`, `failed` `{reason}`, `stopped`: an agent's run, with its `agent`, the messages it `held` and `run`, the run's id, the same on each of its steps; `answered` names its `answer`
- `nobody`: the message asked no one and nothing started
- `withdrawn`: its author took it back

What changes about the thread itself is a step too, with no `entry`, so its past can be read back as well as its present:

- `created` `{title, parent?}`, `forked` `{from, at, title}`: the thread began
- `renamed` `{from, to}`, `archived`, `unarchived`, `paused`, `resumed`, `tools` `{tools}`
- `joined`, `changed` `{agent, conversation, model, thinking?, runner, folder}`: an agent's first message here, and each time it moves to another model, runner or folder; `conversation` is the same through every change and rename
- `bot-created` `{bot, to}`, `bot-changed` `{bot, changed, from?, to?, instructions?}`, `bot-forgotten` `{bot}`, in the bot's home: `changed` lists `name`, `agent` or `instructions`, with the old name as `from`, what it runs as now as `to`, and its instructions whole
- `checkout-made` `{path, parent}` or `{path, tip}` when made again, `checkout-removed` `{path, branch}` or `{path, tip}`, `checkout-kept` `{path, why}`: a thread's own checkout, with `checkouts` on
- `scheduled` `{task, by, schedule, instructions}`, `edited` `{task, changed, …}` with what the edit set, `task-paused` `{task, note?}`, `task-resumed`, `cancelled`, and `ended` `{task, why}`: a scheduled task's life, beside its `fired` and `skipped`

These begin with the version that writes them: a thread made before has no `created`, and its first such step is its first change since.

An answer that asks no one in turn writes no `posted` of its own: its run's `answered` or `failed` is its story. The trail keeps no tokens and no transcript; an agent's conversation has those.

By hand, with sqlite3, a thread's last 20 steps (it reads every entry in the store, under a second):

```sql
select id, datetime(json_extract(record, '$.data.at') / 1000, 'unixepoch') as at,
       json_extract(record, '$.data.entry') as message, json_extract(record, '$.data.kind') as step,
       json_extract(record, '$.data') as data
from entries
where json_extract(record, '$.kind') = 'ade.trail' and json_extract(record, '$.data.thread') = 140844
order by id desc limit 20;
```

Or `select at, text from ade_trail where thread_id = 140844 order by id desc limit 20`; see [the house as SQL](server.md#the-house-as-sql).

Modules add routes under their own names. Each of these needs its module on:

```
GET    /api/context?runner=name&dir=folder    the skills there; leave out dir for the runner’s folder
GET    /api/search?q=words                    matching messages across threads, best first
GET    /api/usage?since=ms&until=ms&zone=ms   tokens and cost across the house; zone is the offset from UTC
GET    /api/threads/:id/usage                 this thread’s totals by model; since and until narrow either read
POST   /api/threads/:id/auto-title            asks for a fresh title: {title}, or an error if none comes back
GET    /api/pi-sessions?runner=name&dir=folder   pi sessions there
POST   /api/pi-sessions {runner, dir?, session, title?}   brings one in by id or path: {id}
GET    /api/threads/:id/pi-sessions           {from}, null unless the thread came from pi
GET    /api/checkouts?runner=name&dir=folder  {kind}: jj, git, or null outside a repo
GET    /api/threads/:id/checkouts             its own checkout {state, kind, path, parent, branch, note, …}, or null; the feed's `checkout/<id>` too
GET    /api/threads/:id/canvas                {shapes, tldraw}; its socket at the same path takes ?sessionId=…
POST   /api/threads/:id/canvas                {actions} edits shapes, {look} reads them, {seen} reports the viewer’s selection and view
```

With `bots` on:

```
GET    /api/bots
POST   /api/bots {name, to?, instructions?, append?, color?, projectContext?, rename?}   makes or changes a bot
DELETE /api/bots/:name   forgets a bot and archives its home; every other thread it was in stays
GET    /api/threads/:home/bots?asked=4,7   for a bot's home, each thread that asked her: `{thread, question, answer}`, its first message and her answer to it, or `null`
```

Only the creator or the house owner can change or forget a bot through the API. Other guests get 403. Bots made before ade recorded their creator belong to the house owner; a bot made with the `bot` tool belongs to the same person as the bot that made it.

`rename` gives a bot a new name, under the same rules as a new one. It keeps its home, instructions, model and colour, and its agent in every thread it's in answers to the new name. Messages already written keep the old one, which asks no one now. A bot's home thread always shows the bot's name as its title, so it can't be renamed on its own.

`GET /api/bots` gives each bot an `answeredAt`: an ISO time, the newest message anywhere she answered (not only her home), or `null` if she never has.

A new bot starts with empty `instructions`; it writes its own with the `bot` tool, or you can set them directly. `append` adds one line to its instructions rather than replacing them, the same way the `bot` tool's `append` does. `projectContext: false` drops its folder's AGENTS.md from its prompt, keeping its skills; leave it out or send `true` to restore it. Every bot also reads one shared instruction, `bots.voice`, rendered just before its own: a chatty default until someone edits it in settings or `POST /api/settings {bots: {voice}}`, empty for none. `GET /api/server`'s `settings.bots.voice` gives the text in effect, default included.

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
POST   /api/threads/:id/memory {on}      turns memory on or off; {lines: [{id, n, text}]} adds missing lines and turns it on
GET    /api/threads/:id/memory           {lines}; ?budget=n limits their bytes
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
GET    /api/inbox                       what needs you, one entry per thread: open questions `{thread, kind: "question", question, asker}`, then `{thread, kind: "failed" | "answered", message}`
POST   /api/threads/:id/inbox {dismiss}   hides that question (its message id) until the thread asks again; `{dismissed: null}` if it's no longer the open one
```

A question leaves the inbox once a person writes in its thread, the same moment the thread stops being blocked. A dismissed one stays blocked; it's only out of the inbox. After the questions come, for you alone, threads you wrote in whose last run failed and then those with an answer you haven't read, newest first in each: the ones the sidebar dots red and blue. Reading the thread (`POST /api/threads/:id/read`, what opening it does) takes one out. Threads you never wrote in, like those agents started among themselves, never come.

With `schedule` on:

```
GET    /api/schedule                    every scheduled task in the house, soonest first, then the paused and those waiting on a thread or an event:
                                          [{id, thread, schedule, at?, from?, paused?, note?, runs, ran?, instructions, by, agent?, bot?, to?, check?}]
GET    /api/threads/:id/schedule        the thread's, the same rows
POST   /api/schedule {instructions, bot | thread | to, in | at | every | times | after | when | on, until?, count?, check?, …, key?}
                                        a person's new task: {id, thread}. It runs in `bot`'s home, in `thread` as your own message there,
                                          or with `to` (`{runner, model, thinkingLevel?}`) in a new thread each run, under one made for the task.
                                          When, in Temporal's shapes: `in` (a duration, 90s, 5m, 1h30m, 2d) or `at` (milliseconds, an ISO time,
                                          or `2026-11-24T09:00` on `timeZone`'s clock) once; `every` (a duration, at least 1m) from `at`, or
                                          after `in` or one `every`; `times` (`["09:00", "17:30"]`) on `days` (`["mon", "fri"]` or 0 (Sunday)
                                          to 6; every day if left out) on `timeZone`'s clock, the server's if left out; `after` a thread;
                                          `when` something happens in ade; `on` an event, with hooks on. One that repeats (`every`,
                                          `times`, `on`) can end `until` a time (as `at`, or a duration from now) or after `count` runs
POST   /api/threads/:id/schedule {instructions, …}  the same, running in that thread
POST   /api/schedule {edit, instructions?, <when>?, bot | thread | to?, check?}
                                        changes a task by its id: what's given replaces what it had, a new when starting its wait over
                                          from now. In place, keeping its id and runs: {edited}; moved to another thread, or starting or
                                          stopping listening for events, a new task takes its place with its runs: {edited, id, thread}.
                                          An agent's task stays in its thread
POST   /api/schedule {cancel}           cancels a task by its id: {cancelled}, or {fired} if a one-off ran first, {ended} if it had ended otherwise
POST   /api/schedule {pause, note?} | {resume}  pauses one by its id, with a note why, or resumes it: {paused} or {resumed};
                                          it sleeps that way a moment later
POST   /api/schedule {run}              runs it once now, outside its schedule: {ran}
POST   /api/schedule {move, runner}     a task that starts a new thread each run asks that runner from now on, its model there: {moved, runner}
```

Only the house owner or whoever a task runs as can edit, cancel, pause, resume, move or run it early. Other guests get 403. An agent can cancel tasks it set in its own thread with the `schedule` tool.

The same POSTs under `/api/threads/:id/schedule` refuse a task from another thread. `schedule` is `{at}` once, `{at, every}` every so often from its first run, `{times, days?, timeZone}` at clock times on those weekdays (every day without `days`), `{after}`, `{when}` or `{on}`; one that repeats may carry `until`, in milliseconds, and `count`. `when` is one of `{online: runner}` or `{offline: runner}`, when that runner connects or drops (at once if it already has), or `{failed: thread}` or `{answered: thread}`, the next time a run there fails or an agent there answers; it runs once, as `after` does. A task that ends by itself, after its `count`th run or once its next run would come after `until` (or `until` passes while it's paused or listening), leaves an `ended` step in its thread's trail, and `ran` counts its runs so far when it has a `count`; a run now counts too. `at` is its next run and `from` where the wait for it began, the run before or when a one-off was set; a paused task has neither, and `note` says why. `runs` are its last five, oldest first, each `{at, thread, entry}`, the message it posted, or `{at, skipped}`: a timed run that comes due while its last run's thread still works is skipped, Temporal's default overlap, and `skipped` says why, as `vps offline` when that run waits for an offline runner, else `the run before still working`. A run missed while the server was down runs once on start. `agent` is the agent that set it, `bot` the bot whose home it runs in, `to` the model a new thread each run asks.

With check on (the default), `check` is a script that runs before each run (check.js), at most 16 KB; an edit's `check: ""` removes it, and a task with `to` can't have one. Its runs then also hold `{at, checked, output}`, a check that asked no one (`checked` counts those in a row, folded into one), and `{at, failed, output}`, one that failed; `output` is the first 2000 characters of what it printed, then a line per tool call. The message a check's `post` makes carries `checked`, what it found, which the agent reads after the instructions inside `<check-found>`.

A run posts `{author, body: instructions, scheduledTask: id, to}`: an agent's goes to that agent, asking itself; a person's is theirs, asking the bot, or whom the thread would ask, or the new thread's agent. Subscribe to `schedule` or `schedule/<id>` on the `/ws` feed to hear tasks added, paused, run or cancelled live.

With `hooks` on too, a task can be `on` an outside event, with `schedule: {on}`. The owner, and only the owner, reads its secret:

```
GET    /api/threads/:id/hooks?task=N    {task, on, path, secret, raw, send | github}: where task N's hook is, how to call it, and whether its sender's text gets through
POST   /api/threads/:id/hooks {rotate}  a new secret for that task; the old one is refused from then on, even on a delivery already under way
POST   /api/threads/:id/hooks {task, raw}  `raw: true` lets that hook's sender's text through to the agent, `false` stops it; off until the owner turns it on
```

A hook carries the generation it was issued under; one from an older ade answers 410 here and on its hook: cancel it and schedule a new one.

Its hook is on a listener of its own, `HOOK_PORT`, which answers nothing else, no page and no socket, and takes no owner key or login, only the task's secret:

```
POST   /hooks/:id                       an event for task :id: {ran}, {repeat} for one it took already, {ignored} for one it doesn't wait for or while it's paused; 403 for a wrong secret, 404 once it's cancelled, 413 over a megabyte, 429 over 30 a minute or 500 in its life, counted only once the caller proved the secret, or over 120 tries a minute at GitHub hooks from one caller before its signature is checked (by the last `X-Forwarded-For` address, which Funnel adds), 503 with 8 already in flight, 410 for a hook from an older ade
```

A request has 10 seconds to arrive whole. `on: "hook"` takes `Authorization: Bearer <secret>`, any body, and an optional `X-Hook-Event` name; a repeat is the same `Idempotency-Key` header, else the same body. `push` and `ci` take only a body GitHub signed with the secret (X-Hub-Signature-256), and read the event from its shape, not from GitHub's unsigned headers: a push, or a workflow run or check suite that completed with `failure` or `timed_out`; a ping or any other is `ignored`. A repeat is the same signed body, whatever its delivery id.

The task posts `{author, body: instructions, scheduledTask, event: {from, facts, said?}, to}`: its own instructions, with what came beside them. `from` is `hook`, `GitHub push` or `GitHub CI`. `facts` are typed, each kept to its own shape or given as `(unusual)`: a push's `repo`, `branch`, `before`, `after`, `pusher` and `commits` (a count); a CI run's `repo`, `workflow` (its file, like `.github/workflows/ci.yml`), `workflow_id`, `conclusion` and `url`, never its name; a plain call's `event` and `bytes`. `said`, the sender's own text up to 2000 characters (the head commit's message, the run's title, the call's body), comes only once the owner turned `raw` on for that hook. The agent reads the event after its instructions in an `<outside-event>` block, escaped, as data from outside ade, not instructions.

With `export` on:

```
GET    /api/export   {files}, every thread's files, archived ones included, as a map of file name to its text:
                       one Markdown file and one JSON file per thread, sent as it's read; nothing is written anywhere
```

Each JSON file holds a thread's entries exactly as `GET /api/threads/:id` returns them. Its Markdown file is for a
person: the title, who wrote in it, then each message as "**author** · time" with the body; a `$ cmd` message's
shell result folds into one line. Both read without ade installed, and the route reaches a server anywhere, not
only its own machine; `ade export <dir>` fetches it and writes the files.

Outside the API, `/` serves the page, its assets alongside it and its dependencies under `/packages/`. Runners fetch `/connect-runner`, `/runner/updater.js` and `/runner/bundle`, then connect to `/ws?runner=name` ([runner protocol](../remote.js)).

The CLI is the same API from a terminal:

```sh
ade post "hello" --to sonnet@laptop    # prints the answer as it lands
ade threads
ade read 3
ade wait 3                             # waits for its agents, then prints the answers
ade stop 3
ade export ~/backup                    # with export on: every thread as Markdown and JSON
```

It writes as whoever the server takes it for: on the server's machine, the owner, though an agent's shell there only reads. Against a server elsewhere (`--server` or `ADE_SERVER`), set `ADE_OWNER_KEY` to write as the owner; through a Serve address you're your tailnet login without it, which for the owner only reads. `ade link`, on the server's machine, prints a link that brings a browser in as the owner.

A new thread prints `thread N` on stdout, followed by any answers; progress and errors go to stderr. To capture just its id without waiting:

```sh
thread=$(ade post "hello" --to sonnet@laptop --no-wait)
ade wait "${thread#thread }"
```

`ade --help` has the rest.

## Server settings

The server's address and data path are set in the environment, not in `ade.json`:

```sh
PORT=3001 npx --allow-git=all github:oskarrough/ade     # a fixed port; otherwise the first free one from 3000
DB_PATH=other.sqlite npx --allow-git=all github:oskarrough/ade
```

These win over the file; leave them unset to choose from the page. Only the owner changes settings: `POST /api/settings` from anyone else is refused with 403, since settings name the owner and the tailnet logins that count as them. Saving answers `{saved, restarts}` and restarts the server or stops it. A save that sets `invites: true` also keeps the owner key as the asking browser's cookie, so turning invites on from the page doesn't lock that page out.

```sh
MODULES=+web-search,-talk npx --allow-git=all github:oskarrough/ade
MEMORY_MODEL=sonnet@laptop npx --allow-git=all github:oskarrough/ade
```

From a clone, use `node server.js` in place of `npx --allow-git=all github:oskarrough/ade`.

Threads and conversations live in `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite`, with its `-wal`, `-shm`, `.lock` and the server's output in `ade.log` beside it. Every folder you start in sees the same threads. Settings stay in `${XDG_CONFIG_HOME:-~/.config}/ade/ade.json`. `DB_PATH=other.sqlite` selects another store and logs to `other.log` beside it; it does not move settings.

`--no-runner` starts the server without connecting this machine as a runner.
