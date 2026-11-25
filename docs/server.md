# Running the server

Runners, who gets in, settings, where things live, and the house as SQL.

## Runners

On the server's own machine, `ade runner` in a folder lends that folder too, as a runner named after it; it makes its own key. A name that already holds a key belongs to another runner, offline or not: `ade runner` asks for its own name, and takes that one over only when you name it with `--name`. A new key for a runner that has one, from Add runner or `ade key`, says it replaces it.

Nothing moves to another runner on its own. When work waits for a runner that's offline, a thread's agent, a bot asked there, or a scheduled task that starts a new thread on it, it says so: "vps is offline. Run on", with a button for each online runner that has its model. Pressing one moves it there, as picking that runner in the model picker would: same model and thinking, its folder starting over in that runner's, and a turn held up by the runner it leaves goes on there. For a bot, the bot moves, so asking it anywhere asks it there; for a scheduled task, its runs start there from now on. The model picker lists offline runners greyed out, and says when a pick on another runner starts the folder over.

An agent works on its own runner, but can run a command on any runner that accepts its commands: `runners` lists the house's runners, and `bash` takes a `runner` to run it there, in that runner's folder. Its conversation stays put; a command whose runner drops mid-call reports it may have run.

Agents start in the folder you run ade from. Add shortcuts with `--dir ~/sites --dir ~/notes`; threads start in the first, and the folder picker suggests them all. A thread can start in any folder on the machine, though: type its path in the picker. Ade has no sandbox: doing one properly is hard, and a half-baked one would only make you feel safe.

To update, stop the server and run the same `npx` line: npx fetches the newest commit when there is one, and runners on other machines follow the server on their own. `pnpm dlx` and `bunx` work just as well, or fork/clone the repo and `npm link` (or `pnpm link`) it to get an `ade` command.

## Who gets in

[SECURITY.md](../SECURITY.md) says who gets in and what they can do. To let in your other devices and friends, point `tailscale serve` at the port the server prints marked `serve`, never the first one, and list your own login in ade.json's `ownerLogins` (`["you@github"]`); each device writes as you once it opens the owner link. Your name is `owner` in ade.json, or else your login on the server's machine. For invite-only, turn on Invites in Settings' People, or set `"invites": true` and restart.

## Settings

Settings live in `~/.config/ade/ade.json` (or under `$XDG_CONFIG_HOME`), wherever you start. For example, to turn web search on and talk off:

```json
{
	"modules": ["+web-search", "-talk"]
}
```

Use `+` and `-` to change the defaults; a list of bare names replaces them. A name that matches no module in `modules/` gets a warning on start-up and is skipped, not a refusal to boot.

Threads live in `${XDG_DATA_HOME:-~/.local/share}/ade/ade.sqlite`, with its SQLite sidecars, lock and `ade.log` beside it. It's ade's database: Pi Durable keeps its records there, and the `ade_` tables beside them hold the house as plain SQL (see [below](#the-house-as-sql)). Settings stay in `${XDG_CONFIG_HOME:-~/.config}/ade/ade.json`. `DB_PATH` selects another store and puts its log beside it; it does not move settings.

A thread keeps what each of its agents and bots hasn't read yet as a place in the thread, the last message it was handed, plus the odd message left behind it while the director picked. So a member waiting on an offline runner costs every post the same few bytes, however long the thread. A store from before it kept them that way gets converted, with a backup beside it.

A release that changes what the store holds says how to convert an older one, in `conversions` in server.js. A release arbe desktop just swapped in converts the store itself before it starts, after backing it up beside the store; if it then stops before it's listening, the app goes back to the release before it and puts that backup back first, so older code never meets converted data. Anywhere else, a checkout or npx, the server refuses to start and prints the one command that backs up and converts, to run once with ade stopped.

Server secrets, like `TYPESAFE_API_KEY` and `MATRIX_TOKEN`, go in `${XDG_CONFIG_HOME:-~/.config}/ade/.env`, loaded at start-up if it exists; a variable already set in the shell wins over it.

The server's address, port, Serve port and data file come from the environment (`HOST`, `PORT`, `SERVE_PORT`, `DB_PATH`), and so can `MODULES`. These win over the file. `SERVE_PORT` is the first free one after `PORT` unless you set it; set it, so `tailscale serve` always finds it.

## The house as SQL

Ade's database also holds the house as ordinary tables, beside the records Pi Durable keeps there: `ade_threads`, `ade_bots`, `ade_agents`, `ade_messages` (with `ade_asks`, `ade_replies` and `ade_reads`), `ade_runs` (with `ade_run_messages`), `ade_turns`, `ade_spend`, `ade_trail` and `ade_schedules`, and a full-text index over the messages. Open it with `sqlite3 ~/.local/share/ade/ade.sqlite` and `.schema ade_runs` says what each column is. Everything of ours starts with `ade_`; the rest is Pi's.

Pi's records stay the truth; ade works these tables out from them, and reads them itself for the threads list. A start keeps them when they're true as of Pi's last commit, as a clean stop leaves them; after a crash, or once ade changes what they hold, it makes them again from Pi's records, in the background (about six seconds for 90,000 entries), and the list reads Pi's records meanwhile. From then each commit goes into them within a twentieth of a second, or at once when the list asks in between; if one ever fails to apply, `ade_projection` says `broken` and they're made again. The owner's `POST /api/read {"rebuild": true}` drops them and makes them again now. Ids are Pi's own: a message's id here is its entry id everywhere else. Times are ISO text in UTC, and null where Pi holds none, as for messages older than their timestamps.

SQLite lets one writer in at a time, and Pi's commits come first: the tables are written from a thread of their own, in short transactions a few times a second, so a commit seldom finds them being written and then waits milliseconds.

A run is messages handed to an agent and what came of it: `waiting`, `running`, `answered`, `failed`, `stopped`, or `silent` when it posted nothing itself, usually because its messages joined a turn another run answered. A turn is one stretch of the agent working, and the model calls in `ade_spend` belong to turns. A run names its turn only once Pi's own record of the input says which entry answered it; where that can't be shown, `turn_id` is null rather than a guess.

The tables are what the house is now. What a thread, a bot or a scheduled task used to be is in `ade_trail`, which keeps a step for each change (see [the trail](api.md#the-trail)).

Why did this fail? The failed runs since a date, with what was asked, and one message's whole story:

```sql
select runs.started_at, threads.title, agents.name as agent, substr(asked.body, 1, 40) as asked, runs.error
from ade_runs runs
join ade_threads threads on threads.id = runs.thread_id
left join ade_agents agents on agents.conversation_id = runs.conversation_id
left join ade_messages asked on asked.id = (select max(message_id) from ade_run_messages where run_id = runs.id)
where runs.status = 'failed' and runs.started_at >= '2026-11-22'
order by runs.id desc;

select at, text from ade_trail where message_id = 194709 order by id;
```

What's still running, on what, and how many model calls in:

```sql
select runs.id, threads.title, agents.name as agent, runs.status, runs.started_at, turns.model, turns.runner,
  (select count(*) from ade_spend where turn_id = turns.id) as calls
from ade_runs runs
join ade_threads threads on threads.id = runs.thread_id
left join ade_agents agents on agents.conversation_id = runs.conversation_id
left join ade_turns turns on turns.conversation_id = runs.conversation_id and turns.status = 'running'
where runs.status in ('waiting', 'running')
order by runs.id;
```

When will this fire, and when did it last?

```sql
select schedules.id, schedules.status, schedules.next_run_at, threads.title, schedules.set_by, schedules.schedule,
  (select max(at) from ade_messages where schedule_id = schedules.id) as last_ran
from ade_schedules schedules join ade_threads threads on threads.id = schedules.thread_id
where schedules.status in ('waiting', 'paused')
order by schedules.next_run_at is null, schedules.next_run_at;
```

What did that answer cost? Thread 489's last five answers, each with the turn that wrote it; `runs_in_turn` above 1 means the turn, and its cost, answered that many runs:

```sql
with answer as (select * from ade_messages where thread_id = 489 and kind = 'answer' order by id desc limit 5)
select answer.id, answer.author, substr(answer.body, 1, 30) as said, turns.model, turns.runner,
  round((julianday(turns.ended_at) - julianday(turns.started_at)) * 86400) as seconds,
  (select count(*) from ade_spend where turn_id = turns.id) as calls,
  (select round(sum(cost), 2) from ade_spend where turn_id = turns.id) as cost,
  (select count(*) from ade_runs shared where shared.turn_id = turns.id) as runs_in_turn
from answer join ade_runs runs on runs.id = answer.run_id left join ade_turns turns on turns.id = runs.turn_id
order by answer.id desc;
```

`GET /api/read` says whether the tables are current, the commit they're true as of and how many rows each has. `GET /api/read?check` compares them with Pi's records, both as one transaction sees them, off the server's own thread, and answers `{seq, differences}`: each difference `{check, table, id, differs}`, none when they agree. It checks two ways: the tables against ones made afresh, every column of every row (`rebuild`), and their facts and links against Pi's records in SQL that shares nothing with the code that wrote them (`pi`). The same check runs a minute after the server starts and once a day, and writes what it finds to `ade.log`. A bot is its home thread here, its name a label; an agent in a thread goes by the name it has there now. `ade_spend` leaves out what compaction cost, which `usage` counts.
