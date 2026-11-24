/**
 * The house as plain SQL tables, in ade's database beside the records Pi Durable keeps there: `ade_threads`,
 * `ade_messages`, `ade_runs`, `ade_turns`, `ade_spend`, `ade_trail`, `ade_schedules`, `ade_bots` and their links, to
 * read with `sqlite3`, and the threads list reads them too.
 *
 * Pi's records stay the truth. The `ade_` tables are worked out from them and nothing but this file writes them, so
 * they can be dropped at any time. A start keeps them when they're true as of Pi's last commit, as a clean stop leaves
 * them, and otherwise makes them again from Pi's records as one transaction sees them (about six seconds for 90,000
 * entries, in the background). From then each commit Pi stores is applied whole, in one transaction that also moves
 * `ade_projection.seq`. A commit that fails to apply, or one that doesn't follow the last, marks them `broken` and
 * they're made again. Ids are Pi's own, times ISO text in UTC.
 *
 * One writer at a time is SQLite's rule, and Pi's commits are the ones that matter. So the tables are written by a
 * worker thread on a connection of its own, which waits its turn, never holds the server's thread, and writes seldom
 * and briefly: the commits of each twentieth of a second together, or five milliseconds' worth and then five of
 * leaving the database alone while the tables are being made. Pi's migrations
 * look only at their own version row and never at a table they don't know; the `ade_` prefix keeps a table Pi adds
 * later from meeting one of ours.
 *
 * The tables are current views: what the house is now, not what it was. A thread's or a bot's past is in its trail,
 * which keeps a step for each change. Messages, asks, replies, trail steps, agents' spend and the search index come
 * from Pi's entries alone; the rest mirror its documents and task records.
 *
 * `GET /api/read` answers `{file, state, seq, version, rows}`. `POST /api/read {rebuild: true}` drops the tables and
 * makes them again now. `GET /api/read?check` compares them with Pi's records, both as one transaction sees them:
 * `{seq, differences: [{check, table, id, differs}]}`, none when they agree. `rebuild` is the tables against ones
 * made afresh, every column of every row; `pi` is their facts and links against Pi's records, in SQL that shares
 * nothing with the code that wrote them. The check also runs a minute after start and once a day, and logs what it
 * finds.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { stepText } from './util.js'

/** The projector's logic: raise it with any change to what a row holds, so `projection.version` names what wrote the file */
const LOGIC = 2
/** The one version of Pi's tables this reads */
const PI_SCHEMA = 2
const DAY = 86_400_000

const SCHEMA = `
create table ade_projection (
	one            integer primary key check (one = 1),
	version        text    not null,           -- this schema and the projector's logic, hashed
	seq            integer not null,           -- Pi's commit this file is true as of
	state          text    not null,           -- 'current', or 'broken: why' until it's made again
	built_at       text    not null
) strict;

create table ade_threads (
	id             integer primary key,        -- Pi's conversation id
	title          text    not null,
	parent_id      integer references ade_threads (id),
	forked_from_id integer references ade_threads (id),
	forked_at_id   integer,                    -- the last entry of forked_from_id it shares
	created_at     text,
	archived       integer not null check (archived in (0, 1)),
	paused         integer not null check (paused in (0, 1)),
	hands_off      integer not null check (hands_off in (0, 1)),
	trail_id       integer                     -- Pi's conversation holding its trail
) strict;
create index ade_threads_by_parent on ade_threads (parent_id);

-- A bot is its home thread; its name is a label that can change
create table ade_bots (
	home_id        integer primary key references ade_threads (id),
	name           text    not null unique,
	model          text,
	thinking       text,
	runner         text,
	folder         text,
	instructions   text    not null
) strict;

-- A thread's one agent (name 'agent') and each bot in it, by the name it has there now
create table ade_agents (
	conversation_id integer primary key,       -- Pi's conversation: what this agent has read, its tool calls, its answers
	thread_id      integer not null references ade_threads (id),
	name           text    not null,
	runner         text,                       -- where it runs now; none for a model off any runner
	model          text,                       -- none until Pi holds its settings in its own conversation, as a fork's agent before it changes
	thinking       text,
	folder         text,                       -- the whole path, on its runner's machine
	unique (thread_id, name)
) strict;

create table ade_messages (
	id             integer primary key,        -- Pi's entry id; a thread's messages in id order are in the order written
	thread_id      integer not null references ade_threads (id),
	at             text,                       -- null where Pi holds no time, as for messages before 2026-11-19
	author         text    not null,
	kind           text    not null check (kind in ('said', 'answer', 'error', 'question', 'posted', 'scheduled', 'stopped')),
	body           text    not null,           -- empty once withdrawn
	images         integer not null,           -- how many; the bytes stay in Pi
	from_thread_id integer references ade_threads (id),   -- the thread that posted it here
	run_id         integer references ade_runs (id),      -- the run that wrote it, for an answer or error
	schedule_id    integer references ade_schedules (id), -- the scheduled task that posted it
	picked         text,                       -- the director's reason, once it picked
	withdrawn      integer not null default 0 check (withdrawn in (0, 1)),
	command        text    check (command in ('ran', 'failed', 'stopped'))   -- a $ command someone ran, and how it ended
) strict;
create index ade_messages_by_thread on ade_messages (thread_id, id);
create index ade_messages_by_kind on ade_messages (thread_id, kind, id, author);
create index ade_messages_by_command on ade_messages (thread_id, id) where command in ('ran', 'failed');
create index ade_messages_by_author on ade_messages (author, id);
create index ade_messages_by_run on ade_messages (run_id) where run_id is not null;

-- Whom a message asks: an agent's name in its thread
create table ade_asks (
	message_id     integer not null references ade_messages (id),
	agent          text    not null,
	primary key (message_id, agent)
) strict, without rowid;

-- The messages a message answers
create table ade_replies (
	message_id     integer not null references ade_messages (id),
	to_id          integer not null references ade_messages (id),
	primary key (message_id, to_id)
) strict, without rowid;
create index ade_replies_by_to on ade_replies (to_id);

-- The newest message each person has read in each thread
create table ade_reads (
	thread_id      integer not null references ade_threads (id),
	person         text    not null,
	message_id     integer not null,
	primary key (thread_id, person)
) strict, without rowid;

-- A turn: one stretch of an agent working, from the messages it takes to its last word. Pi's pi.generation task.
create table ade_turns (
	id             integer primary key,
	thread_id      integer not null references ade_threads (id),
	conversation_id integer not null,
	status         text    not null check (status in ('running', 'completed', 'failed', 'stopped')),
	started_at     text,
	ended_at       text,
	provider       text,                       -- what it ran as, from its first model call
	model          text,
	runner         text
) strict;
create index ade_turns_by_conversation on ade_turns (conversation_id, id);
create index ade_turns_by_status on ade_turns (status, id);

-- A run: messages handed to an agent, and what came of it. Several runs can share a turn, when one takes more
-- messages while it works. Pi's ade.deliver task.
create table ade_runs (
	id             integer primary key,
	thread_id      integer not null references ade_threads (id),
	conversation_id integer not null,
	status         text    not null check (status in ('waiting', 'running', 'answered', 'failed', 'stopped', 'silent')),
	started_at     text,
	ended_at       text,
	turn_id        integer references ade_turns (id),     -- the turn that answered it; none where Pi can't say
	answer_id      integer references ade_messages (id),
	error          text,
	admit_id       integer,                    -- Pi's ade.admit task, which hands it its messages
	submission_id  integer,                    -- Pi's submission: the input the agent took
	first_entry_id integer                     -- where it starts in the agent's conversation
) strict;
create index ade_runs_by_thread on ade_runs (thread_id, id);
create index ade_runs_by_conversation on ade_runs (conversation_id, id);
create index ade_runs_by_status on ade_runs (status, id);
create index ade_runs_by_admit on ade_runs (admit_id);
create index ade_runs_by_submission on ade_runs (submission_id);
create index ade_runs_by_turn on ade_runs (turn_id);

-- The messages a run took
create table ade_run_messages (
	run_id         integer not null references ade_runs (id),
	message_id     integer not null references ade_messages (id),
	primary key (run_id, message_id)
) strict, without rowid;
create index ade_run_messages_by_message on ade_run_messages (message_id);

-- Tokens and list-price cost: one row per model call an agent made, and per hour of a module's calls
create table ade_spend (
	entry_id       integer unique,             -- Pi's pi.assistant entry, for an agent's call; none for a module's
	thread_id      integer not null references ade_threads (id),
	conversation_id integer,
	turn_id        integer references ade_turns (id),
	at             text    not null,
	purpose        text    not null,           -- 'agent', or a module's: 'memory', 'titles', 'director', 'recap'
	runner         text    not null,
	provider       text    not null,
	model          text    not null,
	calls          integer not null,
	input          integer not null,
	output         integer not null,
	cache_read     integer not null,
	cache_write    integer not null,
	cost           real    not null,
	from_provider  integer not null check (from_provider in (0, 1))   -- the provider reported the cost itself
) strict;
create index ade_spend_by_thread on ade_spend (thread_id, at);
create index ade_spend_by_at on ade_spend (at);
create index ade_spend_by_turn on ade_spend (turn_id) where turn_id is not null;

-- What happened in a thread, one step a row
create table ade_trail (
	id             integer primary key,        -- Pi's entry id
	thread_id      integer not null references ade_threads (id),
	message_id     integer,                    -- the message the step is about
	run_id         integer,                    -- the run it's a step of
	at             text    not null,
	kind           text    not null,
	agent          text,
	text           text    not null,           -- the step as a sentence
	data           text    not null check (json_valid(data))   -- the rest of what it recorded
) strict;
create index ade_trail_by_thread on ade_trail (thread_id, id);
create index ade_trail_by_message on ade_trail (message_id, id);
create index ade_trail_by_run on ade_trail (run_id) where run_id is not null;

create table ade_schedules (
	id             integer primary key,        -- Pi's ade.scheduled-task id
	thread_id      integer not null references ade_threads (id),
	set_by         text    not null,
	instructions   text    not null,
	schedule       text    not null check (json_valid(schedule)),
	after_thread_id integer references ade_threads (id),
	status         text    not null check (status in ('waiting', 'paused', 'ended', 'cancelled')),
	next_run_at    text,
	set_at         text,
	ended_at       text
) strict;
create index ade_schedules_by_thread on ade_schedules (thread_id);
create index ade_schedules_by_next on ade_schedules (next_run_at) where next_run_at is not null;

-- Search: SQLite's full-text index over messages.body, kept by the three triggers under it
create virtual table ade_messages_fts using fts5 (
	body, content = 'ade_messages', content_rowid = 'id', tokenize = 'porter unicode61 remove_diacritics 2'
);
create trigger ade_messages_fts_in after insert on ade_messages begin
	insert into ade_messages_fts (rowid, body) values (new.id, new.body);
end;
create trigger ade_messages_fts_out after delete on ade_messages begin
	insert into ade_messages_fts (ade_messages_fts, rowid, body) values ('delete', old.id, old.body);
end;
create trigger ade_messages_fts_body after update of body on ade_messages begin
	insert into ade_messages_fts (ade_messages_fts, rowid, body) values ('delete', old.id, old.body);
	insert into ade_messages_fts (rowid, body) values (new.id, new.body);
end;

-- Each thread a person wrote in whose newest answer or error they haven't read
create view ade_unread as
select wrote.person, ade_threads.id as thread_id, ade_threads.title, newest.id as message_id, newest.kind = 'error' as failed
from ade_threads
join (select distinct thread_id, author as person from ade_messages where kind = 'said') wrote on wrote.thread_id = ade_threads.id
left join ade_reads on ade_reads.thread_id = ade_threads.id and ade_reads.person = wrote.person
join ade_messages newest on newest.id = (
	select max(id) from ade_messages where thread_id = ade_threads.id and kind in ('answer', 'error'))
where not ade_threads.archived and newest.id > coalesce(ade_reads.message_id, 0);
`

const TABLES = {
	threads: 'id',
	bots: 'home_id',
	agents: 'conversation_id',
	messages: 'id',
	asks: 'message_id, agent',
	replies: 'message_id, to_id',
	reads: 'thread_id, person',
	turns: 'id',
	runs: 'id',
	run_messages: 'run_id, message_id',
	spend: 'entry_id, thread_id, at, purpose, provider, model, runner',
	trail: 'id',
	schedules: 'id',
}
const version = createHash('sha256').update(`${LOGIC}\n${SCHEMA}`).digest('hex').slice(0, 12)
/** Null where Pi has no time yet, as for a task it hasn't started */
const iso = (ms) => (ms === undefined || ms === null ? null : new Date(ms).toISOString())
const whole = (count) => Math.round(count ?? 0)
const quoted = (kinds) => kinds.map((kind) => `'"${kind}"'`).join(', ')

const MESSAGE = 'ade.message'
const ROUTE = 'ade.route'
const WITHDRAWAL = 'ade.withdrawal'
const TRAIL = 'ade.trail'
const ASSISTANT = 'pi.assistant'
const THREAD = 'ade.thread'
const BOTS = 'ade.bots'
const AGENT = 'pi.agent'
const USAGE = 'ade.usage'
const DELIVER = 'ade.deliver'
const ADMIT = 'ade.admit'
const GENERATION = 'pi.generation'
const SCHEDULED = ['ade.scheduled-task', 'ade.wake']

/** A message's kind, from what its entry alone says */
const kindOf = (data) =>
	data.error
		? 'error'
		: data.answer
			? 'answer'
			: data.waitingOnPerson
				? 'question'
				: data.scheduledTask || data.wake
					? 'scheduled'
					: data.from || data.posted
						? 'posted'
						: data.stopped
							? 'stopped'
							: 'said'

/** Our own connection to the database: it waits its turn behind Pi's commits, and never checks a foreign key on a
 * write; the check holds the rows to them */
function open(file) {
	const db = new DatabaseSync(file)
	db.exec('pragma busy_timeout = 5000; pragma synchronous = normal; pragma foreign_keys = off')
	return db
}

/** Takes the read model's tables out of `db`, if it has them: a transaction a table, the one that says they're
 * current first, so none of it holds Pi's commits up for long */
function dropFrom(db) {
	db.exec('drop view if exists ade_unread')
	for (const table of ['projection', 'messages_fts', ...Object.keys(TABLES)])
		db.exec(`drop table if exists ade_${table}`)
}

/**
 * Writes Pi's records into `db`'s tables: one function per kind of record, each an upsert by Pi's id. `apply` takes
 * one commit's records, or a whole snapshot's, in the order they depend on each other, whatever order they came in.
 */
function projector(db) {
	const prepared = new Map()
	const statement = (sql) => {
		let found = prepared.get(sql)
		if (!found) prepared.set(sql, (found = db.prepare(sql)))
		return found
	}
	const run = (sql, ...params) => statement(sql).run(...params)
	const get = (sql, ...params) => statement(sql).get(...params)
	/** Each of Pi's conversations: the thread that owns it, and where it was forked from */
	const conversations = new Map()
	const threadOf = (conversation) =>
		conversations.get(conversation)?.owner?.conversationId ?? conversation
	/** Each agent's runner, model, thinking and folder, as its pi.agent document has them, whether or not a thread lists it yet */
	const settings = new Map()

	function thread(id, doc) {
		const tools = doc.tools ?? []
		const forked = conversations.get(id)?.parent
		run(
			`insert into ade_threads (id, title, parent_id, forked_from_id, forked_at_id, created_at, archived, paused, hands_off, trail_id)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (id) do update set title = excluded.title, parent_id = excluded.parent_id,
				created_at = excluded.created_at, archived = excluded.archived, paused = excluded.paused,
				hands_off = excluded.hands_off, trail_id = excluded.trail_id`,
			id,
			doc.title ?? '',
			doc.parent ?? null,
			forked?.conversationId ?? null,
			forked?.at ?? null,
			doc.createdAt || null,
			doc.hidden ? 1 : 0,
			doc.paused ? 1 : 0,
			['-write', '-edit', '-bash'].every((tool) => tools.includes(tool)) ? 1 : 0,
			doc.trail ?? null,
		)
		run('delete from ade_reads where thread_id = ?', id)
		for (const [person, message] of Object.entries(doc.reads ?? {}))
			run(
				'insert into ade_reads (thread_id, person, message_id) values (?, ?, ?)',
				id,
				person,
				message,
			)
		// A renamed bot keeps its conversation under the new name; two rows can't hold one name meanwhile
		run('delete from ade_agents where thread_id = ?', id)
		for (const [name, agent] of Object.entries(doc.agents ?? {}))
			run(
				'insert into ade_agents (conversation_id, thread_id, name, runner, model, thinking, folder) values (?, ?, ?, ?, ?, ?, ?)',
				agent.conversation,
				id,
				name,
				...(settings.get(agent.conversation) ?? [null, null, null, null]),
			)
	}

	const settingsOf = (doc) => [
		doc?.model?.provider?.match(/^runner:(.+)$/)?.[1] ?? null,
		doc?.model?.modelId ?? null,
		doc?.thinkingLevel ?? null,
		doc?.cwd ?? null,
	]
	function agent(conversation, doc) {
		const row = settingsOf(doc)
		settings.set(conversation, row)
		run(
			'update ade_agents set runner = ?, model = ?, thinking = ?, folder = ? where conversation_id = ?',
			...row,
			conversation,
		)
	}
	/** A fork's copy of a document carries no value: the one Pi stored for it */
	const copied = (id) =>
		JSON.parse(
			get(
				'select content from document_revisions where document_id = ? order by seq desc limit 1',
				id,
			).content,
		)

	function bots(doc) {
		run('delete from ade_bots')
		for (const [name, bot] of Object.entries(doc))
			run(
				'insert into ade_bots (home_id, name, model, thinking, runner, folder, instructions) values (?, ?, ?, ?, ?, ?, ?)',
				bot.home,
				name,
				bot.to?.model ?? null,
				bot.to?.thinkingLevel ?? null,
				bot.to?.runner ?? null,
				bot.to?.dir ?? null,
				bot.instructions ?? '',
			)
	}

	/** A thread's module calls, as its usage document has them now */
	function usage(threadId, doc) {
		run('delete from ade_spend where thread_id = ? and entry_id is null', threadId)
		for (const bucket of Object.values(doc?.buckets ?? {}))
			run(
				`insert into ade_spend (thread_id, at, purpose, runner, provider, model, calls, input, output, cache_read,
					cache_write, cost, from_provider) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				threadId,
				iso(bucket.at),
				bucket.purpose,
				bucket.runner ?? '',
				bucket.provider ?? '',
				bucket.model ?? '',
				bucket.calls ?? 0,
				whole(bucket.input),
				whole(bucket.output),
				whole(bucket.cacheRead),
				whole(bucket.cacheWrite),
				bucket.cost ?? 0,
				bucket.reported ? 1 : 0,
			)
	}

	function message({ id, conversationId, byTaskId, data }) {
		const kind = kindOf(data)
		const runId = (kind === 'answer' || kind === 'error') && byTaskId ? byTaskId : null
		const { changes } = run(
			`insert into ade_messages (id, thread_id, at, author, kind, body, images, from_thread_id, run_id, schedule_id, picked, command)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
			id,
			conversationId,
			data.createdAt ?? null,
			data.author ?? '',
			kind,
			data.body ?? '',
			data.images?.length ?? 0,
			data.from ?? null,
			runId,
			data.scheduledTask ?? data.wake ?? null,
			data.picked ?? null,
			!data.shell
				? null
				: data.shell.error === 'stopped'
					? 'stopped'
					: data.shell.error
						? 'failed'
						: 'ran',
		)
		// A message seen again changes nothing: its asks may since be the director's
		if (!changes) return
		for (const agent of data.to ?? [])
			run('insert or ignore into ade_asks (message_id, agent) values (?, ?)', id, agent)
		for (const to of data.re ?? [])
			run('insert or ignore into ade_replies (message_id, to_id) values (?, ?)', id, to)
		if (kind === 'answer') run('update ade_runs set answer_id = ? where id = ?', id, runId)
		if (kind === 'error') run('update ade_runs set error = ? where id = ?', data.body ?? '', runId)
		if (runId) settle(runId)
	}

	function route({ data }) {
		run('update ade_messages set picked = ? where id = ?', data.picked ?? null, data.message)
		run('delete from ade_asks where message_id = ?', data.message)
		for (const agent of data.to ?? [])
			run('insert or ignore into ade_asks (message_id, agent) values (?, ?)', data.message, agent)
	}

	/** Taken back: the row stays, so positions hold, but what it said is gone, from search too */
	function withdrawal({ data }) {
		run(`update ade_messages set body = '', images = 0, withdrawn = 1 where id = ?`, data.message)
	}

	function step({ id, data }) {
		const { thread, entry, at, kind, agent, run: runId, ...rest } = data
		run(
			`insert into ade_trail (id, thread_id, message_id, run_id, at, kind, agent, text, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (id) do nothing`,
			id,
			thread,
			entry ?? null,
			runId ?? null,
			iso(at),
			kind,
			agent ?? null,
			stepText(data),
			JSON.stringify(rest),
		)
	}

	/** One model call an agent made, under the turn that made it: Pi's task that wrote the entry */
	function call({ id, conversationId, byTaskId, model }) {
		for (const said of model ?? []) {
			if (said.role !== 'assistant' || !said.usage) continue
			const { usage } = said
			run(
				`insert into ade_spend (entry_id, thread_id, conversation_id, turn_id, at, purpose, runner, provider, model, calls,
					input, output, cache_read, cache_write, cost, from_provider)
				values (?, ?, ?, ?, ?, 'agent', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?) on conflict (entry_id) do nothing`,
				id,
				threadOf(conversationId),
				conversationId,
				byTaskId ?? null,
				iso(said.timestamp ?? 0),
				said.runner ?? '',
				said.provider ?? '',
				said.model ?? '',
				whole(usage.input),
				whole(usage.output),
				whole(usage.cacheRead),
				whole(usage.cacheWrite),
				typeof usage.cost === 'number' ? usage.cost : (usage.cost?.total ?? 0),
				usage.cost?.totalFromProvider ? 1 : 0,
			)
			if (byTaskId)
				run(
					'update ade_turns set provider = ?, model = ?, runner = ? where id = ? and model is null',
					said.provider ?? '',
					said.model ?? '',
					said.runner ?? '',
					byTaskId,
				)
		}
	}

	const ended = (task) => (task.state.status === 'terminal' ? task.state.outcome.status : undefined)

	function turn(task) {
		const outcome = ended(task)
		run(
			`insert into ade_turns (id, thread_id, conversation_id, status, started_at, ended_at) values (?, ?, ?, ?, ?, ?)
			on conflict (id) do update set status = excluded.status, started_at = excluded.started_at,
				ended_at = excluded.ended_at`,
			task.id,
			threadOf(task.conversationId),
			task.conversationId,
			outcome === undefined
				? 'running'
				: outcome === 'completed'
					? 'completed'
					: outcome === 'aborted'
						? 'stopped'
						: 'failed',
			iso(task.startedAt),
			iso(task.endedAt),
		)
	}

	/** How Pi's task ended, kept in `status` until `settle` reads it with the run's answer and error */
	const TASK = { completed: 'silent', aborted: 'stopped', failed: 'failed', faulted: 'failed' }
	function deliver(task) {
		const outcome = ended(task)
		run(
			`insert into ade_runs (id, thread_id, conversation_id, admit_id, status, started_at, ended_at) values (?, ?, ?, ?, ?, ?, ?)
			on conflict (id) do update set started_at = excluded.started_at, ended_at = excluded.ended_at,
				status = iif(excluded.status = 'waiting', ade_runs.status, excluded.status)`,
			task.id,
			task.conversationId,
			task.input.agent,
			task.input.admit ?? null,
			outcome === undefined ? 'waiting' : TASK[outcome],
			iso(task.startedAt),
			iso(task.endedAt),
		)
		settle(task.id)
	}

	/** The admission that handed a run its messages: which ones, and as which input of the agent's */
	function admit(task) {
		const result = ended(task) === 'completed' ? task.state.outcome.result : undefined
		const found = result && get('select id from ade_runs where admit_id = ?', task.id)
		if (!found) return
		if (result.submission)
			run('update ade_runs set submission_id = ? where id = ?', result.submission, found.id)
		for (const held of result.held ?? [])
			run(
				'insert or ignore into ade_run_messages (run_id, message_id) values (?, ?)',
				found.id,
				held,
			)
	}

	/** Pi's record of an input: where it sits in the agent's conversation and, once answered, the entry that answers it,
	 * whose turn is the run's */
	function submission(record) {
		if (record.type !== 'input') return
		const found = get('select id, status from ade_runs where submission_id = ?', record.id)
		if (!found) return
		if (record.entry !== undefined)
			run('update ade_runs set first_entry_id = ? where id = ?', record.entry, found.id)
		if (record.status === 'placed' && found.status === 'waiting')
			run(`update ade_runs set status = 'running' where id = ?`, found.id)
		if (record.status === 'done')
			run(
				'update ade_runs set turn_id = (select turn_id from ade_spend where entry_id = ?) where id = ?',
				record.answer,
				found.id,
			)
	}

	/** A run that ended is answered or failed by what it posted, whatever order the two arrived in */
	function settle(id) {
		run(
			`update ade_runs set status = case when answer_id is not null then 'answered' when error is not null then 'failed'
				else status end where id = ? and status = 'silent'`,
			id,
		)
	}

	function schedule(task) {
		const { input, state } = task
		const checkpoint = state.checkpoint ?? {}
		const { at, every, after } = input
		const plan = checkpoint.schedule ?? input.schedule ?? { at, every, after }
		const outcome = ended(task)
		run(
			`insert into ade_schedules (id, thread_id, set_by, instructions, schedule, after_thread_id, status, next_run_at, set_at, ended_at)
			values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			on conflict (id) do update set instructions = excluded.instructions, schedule = excluded.schedule,
				after_thread_id = excluded.after_thread_id, status = excluded.status, next_run_at = excluded.next_run_at,
				set_at = excluded.set_at, ended_at = excluded.ended_at`,
			task.id,
			task.conversationId,
			input.by ?? input.author ?? '',
			checkpoint.instructions ?? input.instructions ?? input.note ?? '',
			JSON.stringify(plan),
			plan.after ?? null,
			outcome
				? outcome === 'aborted'
					? 'cancelled'
					: 'ended'
				: checkpoint.paused
					? 'paused'
					: 'waiting',
			outcome ? null : iso(state.until),
			iso(task.startedAt),
			iso(task.endedAt),
		)
	}

	const ENTRIES = {
		[MESSAGE]: message,
		[ROUTE]: route,
		[WITHDRAWAL]: withdrawal,
		[TRAIL]: step,
		[ASSISTANT]: call,
	}
	const TASKS = {
		[DELIVER]: deliver,
		[ADMIT]: admit,
		[GENERATION]: turn,
		[SCHEDULED[0]]: schedule,
		[SCHEDULED[1]]: schedule,
	}

	/**
	 * `records` is `{conversations, documents, tasks, entries, submissions}`, each a list of Pi's records; a document is
	 * `{kind, owner, value}`, its value undefined once retired. They go in in the order they lean on each other: a
	 * thread before its agents' work, a run before the message that answers it, an answer before the input it settles.
	 */
	function apply(
		{ conversations: made = [], documents = [], tasks = [], entries = [], submissions = [] },
		tick = () => {},
	) {
		for (const record of made) conversations.set(record.id, record)
		for (const { kind, owner, value, copy } of documents.toSorted(
			(a, b) => Number(b.kind === THREAD) - Number(a.kind === THREAD),
		)) {
			if (kind === THREAD && value) thread(owner, value)
			else if (kind === AGENT) agent(owner, copy ? copied(copy) : value)
			else if (kind === BOTS) bots(value ?? {})
			else if (kind === USAGE) usage(owner, value)
			tick()
		}
		const order = [GENERATION, DELIVER, ADMIT, ...SCHEDULED]
		for (const task of tasks.toSorted(
			(a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id - b.id,
		)) {
			TASKS[task.kind]?.(task)
			tick()
		}
		for (const entry of entries.toSorted((a, b) => a.id - b.id)) {
			ENTRIES[entry.kind]?.(entry)
			tick()
		}
		for (const record of submissions.toSorted((a, b) => a.id - b.id)) {
			submission(record)
			tick()
		}
		// An admission that found nothing to take leaves a Deliver that did nothing: not a run
		if (tasks.length)
			run(
				`delete from ade_runs where status = 'silent' and submission_id is null and answer_id is null and error is null`,
			)
	}

	/** What a start that keeps the tables needs to know of Pi's records to go on: every conversation, and each agent's
	 * settings */
	function know({ conversations: made, documents }) {
		for (const record of made) conversations.set(record.id, record)
		for (const { owner, value } of documents) settings.set(owner, settingsOf(value))
	}

	return { apply, know }
}

/** Pi's commit its records are true as of, read in the transaction `pi` is in */
const piSeq = (pi) => pi.prepare('select next_seq - 1 as seq from durable_metadata').get().seq

/** The current documents of `kinds`, each `{kind, owner, value}`. Ours and Pi's agents' store their whole value on
 * every change, so the newest revision is the value. */
const documentsOf = (pi, kinds) =>
	pi
		.prepare(
			`select documents.kind, documents.owner_id as owner, revisions.kind as revision, revisions.content
			from documents join document_revisions revisions on revisions.document_id = documents.id
			where documents.kind in (${quoted(kinds)}) and documents.retired_at is null
				and revisions.seq = (select max(seq) from document_revisions where document_id = documents.id)`,
		)
		.all()
		.map(({ kind, owner, revision, content }) => {
			if (revision !== 'base') throw new Error(`Pi holds a ${kind} document as changes, not whole`)
			return { kind: JSON.parse(kind), owner, value: JSON.parse(content) }
		})
const conversationsOf = (pi) =>
	pi
		.prepare('select record from conversations')
		.all()
		.map((row) => JSON.parse(row.record))

/**
 * Everything the read model is made from, as Pi's records stand at one commit: `pi` is a connection inside a
 * transaction, so no commit lands between two of its reads. Answers `{seq, records}`.
 */
function snapshot(pi) {
	{
		const all = (sql) => /** @type {any[]} */ (pi.prepare(sql).all())
		const stored = pi.prepare('select version from durable_schema').get().version
		if (stored !== PI_SCHEMA)
			throw new Error(
				`Pi's records are in schema ${stored}; the read model reads schema ${PI_SCHEMA}`,
			)
		const seq = piSeq(pi)
		const parsed = (rows) => rows.map((row) => JSON.parse(row.record))
		const documents = documentsOf(pi, [THREAD, BOTS, USAGE, AGENT])
		// A turn's record is read for what the read model keeps of it, and an agent's model call for its usage alone: the
		// rest of either is megabytes
		const tasks = [
			...parsed(
				all(`select record from tasks where kind in (${quoted([DELIVER, ADMIT, ...SCHEDULED])})`),
			),
			...all(
				`select id, conversation_id as conversationId, status, record ->> '$.startedAt' as startedAt,
					record ->> '$.endedAt' as endedAt, record ->> '$.state.outcome.status' as outcome
				from tasks where kind = '"${GENERATION}"'`,
			).map(({ status, outcome, endedAt, ...task }) => ({
				...task,
				kind: GENERATION,
				...(endedAt === null ? {} : { endedAt }),
				state: status === 'terminal' ? { status, outcome: { status: outcome } } : { status },
			})),
		]
		const entries = [
			...parsed(
				all(
					`select record from entries where json_extract(record, '$.kind') in ('${[MESSAGE, ROUTE, WITHDRAWAL, TRAIL].join(`', '`)}')`,
				),
			),
			...all(
				`select id, conversation_id as conversationId, record ->> '$.byTaskId' as byTaskId,
					(select json_group_array(json_object('role', said.value ->> '$.role', 'usage', said.value -> '$.usage',
						'provider', said.value ->> '$.provider', 'model', said.value ->> '$.model',
						'runner', said.value ->> '$.runner', 'timestamp', said.value ->> '$.timestamp'))
					from json_each(record, '$.model') said) as model
				from entries where json_extract(record, '$.kind') = '${ASSISTANT}'`,
			).map(({ byTaskId, model, ...entry }) => ({
				...entry,
				kind: ASSISTANT,
				...(byTaskId === null ? {} : { byTaskId }),
				model: JSON.parse(model).map(({ usage, ...said }) => ({
					...said,
					...(usage === null ? {} : { usage }),
				})),
			})),
		]
		return {
			seq,
			records: {
				conversations: conversationsOf(pi),
				documents,
				tasks,
				entries,
				submissions: parsed(all('select record from submissions')),
			},
		}
	}
}

/** One of Pi's publications as the projector takes records: only the kinds it reads, and of a turn and a model call
 * only what it keeps, since these cross to another thread */
function recordsOf(publication) {
	const records = { conversations: [], documents: [], tasks: [], entries: [], submissions: [] }
	for (const change of publication.changes) {
		if (change.type === 'conversation') records.conversations.push(change.value)
		else if (change.type === 'submission') records.submissions.push(change.value)
		else if (change.type === 'entry') {
			const { id, conversationId, byTaskId, kind, model } = /** @type {any} */ (change.value)
			if (kind === ASSISTANT)
				records.entries.push({
					id,
					conversationId,
					byTaskId,
					kind,
					model: (model ?? []).map((said) => ({
						role: said.role,
						usage: said.usage,
						provider: said.provider,
						model: said.model,
						runner: said.runner,
						timestamp: said.timestamp,
					})),
				})
			else if ([MESSAGE, ROUTE, WITHDRAWAL, TRAIL].includes(kind))
				records.entries.push(change.value)
		} else if (change.type === 'task') {
			const { id, conversationId, kind, startedAt, endedAt, state } = /** @type {any} */ (
				change.value
			)
			if (kind === GENERATION)
				records.tasks.push({
					id,
					conversationId,
					kind,
					startedAt,
					endedAt,
					state:
						state.status === 'terminal'
							? { status: state.status, outcome: { status: state.outcome.status } }
							: { status: state.status },
				})
			else if ([DELIVER, ADMIT, ...SCHEDULED].includes(kind)) records.tasks.push(change.value)
		} else if (change.record.kind === AGENT) {
			const owner = /** @type {number} */ (change.conversationId)
			if (change.type === 'document.copy')
				records.documents.push({ kind: AGENT, owner, copy: change.record.id })
			else
				records.documents.push({
					kind: AGENT,
					owner,
					value: change.kind === 'retire' ? undefined : change.value,
				})
		} else if ([THREAD, BOTS, USAGE].includes(change.record.kind)) {
			// A copy carries no value, and none of these is copied by a fork: one that is means this no longer knows them
			if (change.type !== 'document') throw new Error(`a ${change.record.kind} document was copied`)
			records.documents.push({
				kind: change.record.kind,
				owner: change.conversationId ?? 0,
				value: change.kind === 'retire' ? undefined : change.value,
			})
		}
	}
	return JSON.parse(JSON.stringify(records))
}

/** Makes the tables in `db` and fills them from `records`, true as of commit `seq`; `tick` is called between rows.
 * Answers the projector that filled them, which knows every conversation from here on */
function fill(db, { seq, records }, tick) {
	db.exec(SCHEMA)
	db.prepare(
		`insert into ade_projection (one, version, seq, state, built_at) values (1, ?, ?, 'being made', ?)`,
	).run(version, seq, new Date().toISOString())
	const project = projector(db)
	project.apply(records, tick)
	db.exec(`update ade_projection set state = 'current'`)
	return project
}

const rowsOf = (db, table) =>
	db
		.prepare(`select * from ade_${table} order by ${TABLES[table]}`)
		.all()
		.map((row) => JSON.stringify(row))

/** `ours` against one made afresh from the same commit: each row only one of them has, or has differently */
function againstRebuild(ours, fresh) {
	const differences = []
	for (const table of Object.keys(TABLES)) {
		const keys = TABLES[table].split(', ')
		const keyed = (rows) =>
			new Map(rows.map((row) => [keys.map((key) => JSON.parse(row)[key]).join('/'), row]))
		const mine = keyed(rowsOf(ours, table))
		const theirs = keyed(rowsOf(fresh, table))
		for (const [id, row] of theirs) {
			if (!mine.has(id)) differences.push({ check: 'rebuild', table, id, differs: 'missing' })
			else if (mine.get(id) !== row) {
				const [left, right] = [JSON.parse(mine.get(id)), JSON.parse(row)]
				const columns = Object.keys(right).filter((column) => left[column] !== right[column])
				differences.push({ check: 'rebuild', table, id, differs: columns.join(', ') })
			}
		}
		for (const id of mine.keys())
			if (!theirs.has(id))
				differences.push({ check: 'rebuild', table, id, differs: 'not in a rebuild' })
	}
	return differences
}

/**
 * The read model's facts and links against Pi's own records, in SQL of its own: nothing here calls the projector, so
 * the two can't share a mistake. One row per difference.
 */
const FACTS = `
create temp table pi_thread as
select documents.owner_id as id, revisions.content as doc
from documents documents join document_revisions revisions on revisions.document_id = documents.id
where documents.kind = '"${THREAD}"' and documents.retired_at is null
	and revisions.seq = (select max(seq) from document_revisions where document_id = documents.id);
create temp table pi_message as
select id, conversation_id as thread_id, record ->> '$.data.author' as author, record ->> '$.data.createdAt' as at,
	record ->> '$.data.body' as body, record ->> '$.byTaskId' as task, record ->> '$.data.answer' is not null as answers,
	record ->> '$.data.error' is not null as fails, record -> '$.data.to' as asked
from entries where json_extract(record, '$.kind') = '${MESSAGE}';
create index temp.pi_message_by_id on pi_message (id);
create temp table pi_route as
select record ->> '$.data.message' as message, max(id) as id from entries
where json_extract(record, '$.kind') = '${ROUTE}' group by 1;
create temp table pi_withdrawn as
select distinct record ->> '$.data.message' as message from entries where json_extract(record, '$.kind') = '${WITHDRAWAL}';
create temp table pi_call as
select id, conversation_id, record ->> '$.byTaskId' as turn, record ->> '$.model[0].usage.cost.total' as cost
from entries where json_extract(record, '$.kind') = '${ASSISTANT}' and record ->> '$.model[0].usage' is not null;
create index temp.pi_call_by_id on pi_call (id);

select 'threads' as table_name, id, 'missing' as differs from pi_thread where id not in (select id from ade_threads)
union all select 'threads', id, 'not in Pi' from ade_threads where id not in (select id from pi_thread)
union all select 'threads', ade_threads.id, 'title, parent, archived or paused' from ade_threads join pi_thread using (id)
	where ade_threads.title is not doc ->> '$.title' or ade_threads.parent_id is not doc ->> '$.parent'
		or ade_threads.archived is not coalesce(doc ->> '$.hidden', 0) or ade_threads.paused is not coalesce(doc ->> '$.paused', 0)
union all select 'reads', pi_thread.id, 'differs' from pi_thread
	where (select coalesce(json_group_object(person, message_id), '{}') from (select * from ade_reads where thread_id = pi_thread.id order by person))
		is not (select coalesce(json_group_object(key, value), '{}') from (select key, value from json_each(pi_thread.doc, '$.reads') order by key))
union all select 'agents', pi_thread.id, 'missing or renamed: ' || each.key from pi_thread, json_each(pi_thread.doc, '$.agents') each
	where not exists (select 1 from ade_agents where conversation_id = each.value ->> '$.conversation' and name = each.key and thread_id = pi_thread.id)
union all select 'agents', conversation_id, 'not in its thread in Pi' from ade_agents
	where not exists (select 1 from pi_thread, json_each(pi_thread.doc, '$.agents') each
		where pi_thread.id = ade_agents.thread_id and each.key = ade_agents.name and each.value ->> '$.conversation' = ade_agents.conversation_id)
union all select 'messages', id, 'missing' from pi_message where id not in (select id from ade_messages)
union all select 'messages', id, 'not in Pi' from ade_messages where id not in (select id from pi_message)
union all select 'messages', ade_messages.id, 'thread, author or time' from ade_messages join pi_message using (id)
	where ade_messages.thread_id != pi_message.thread_id or ade_messages.author is not coalesce(pi_message.author, '')
		or ade_messages.at is not pi_message.at
union all select 'messages', ade_messages.id, 'body' from ade_messages join pi_message using (id)
	where ade_messages.body is not iif(ade_messages.id in (select message from pi_withdrawn), '', coalesce(pi_message.body, ''))
union all select 'messages', ade_messages.id, 'withdrawn in one only' from ade_messages
	where ade_messages.withdrawn != (ade_messages.id in (select message from pi_withdrawn))
union all select 'messages', ade_messages.id, 'withdrawn but still in search' from ade_messages
	where ade_messages.withdrawn and ade_messages.body != ''
union all select 'asks', pi_message.id, 'not whom Pi says it asks' from pi_message left join pi_route on pi_route.message = pi_message.id
	where (select coalesce(json_group_array(agent), '[]') from (select agent from ade_asks where message_id = pi_message.id order by agent))
		is not (select coalesce(json_group_array(value), '[]') from (select value from json_each(coalesce(
			(select record -> '$.data.to' from entries where id = pi_route.id), pi_message.asked, '[]')) order by value))
union all select 'trail', id, 'missing' from entries where json_extract(record, '$.kind') = '${TRAIL}' and id not in (select id from ade_trail)
union all select 'trail', id, 'not in Pi' from ade_trail where id not in (select id from entries)
union all select 'runs', ade_runs.id, 'not a Deliver task in Pi' from ade_runs where id not in (select id from tasks where kind = '"${DELIVER}"')
union all select 'runs', tasks.id, 'missing' from tasks tasks
	where kind = '"${DELIVER}"' and id not in (select id from ade_runs)
		and exists (select 1 from submissions where conversation_id = tasks.record ->> '$.input.agent'
			and request_id = '"' || (tasks.record ->> '$.input.admit') || '"')
union all select 'runs', ade_runs.id, 'ended in one, not in the other' from ade_runs join tasks using (id)
	where (ade_runs.status in ('waiting', 'running')) != (tasks.status != 'terminal')
union all select 'runs', ade_runs.id, 'answer' from ade_runs
	where ade_runs.answer_id is not (select max(id) from pi_message where task = ade_runs.id and answers)
union all select 'runs', pi_message.task, 'an answer or error of no run' from pi_message
	where (answers or fails) and task is not null and task not in (select id from ade_runs)
union all select 'runs', ade_runs.id, 'failed without an error, or the reverse' from ade_runs
	where (ade_runs.status = 'answered' and ade_runs.answer_id is null)
		or (ade_runs.status = 'failed' and ade_runs.error is null
			and (select record ->> '$.state.outcome.status' from tasks where id = ade_runs.id) = 'completed')
union all select 'runs', ade_runs.id, 'turn is not the one that wrote its answer' from ade_runs join submissions submissions on submissions.id = ade_runs.submission_id
	where ade_runs.turn_id is not (select turn from pi_call where id = submissions.record ->> '$.answer')
union all select 'runs', ade_runs.id, 'input' from ade_runs
	where ade_runs.submission_id is not (select id from submissions where conversation_id = ade_runs.conversation_id
		and request_id = '"' || ade_runs.admit_id || '"')
union all select 'run_messages', ade_runs.id, 'not the messages its admission took' from ade_runs
	where (select coalesce(json_group_array(message_id), '[]') from (select message_id from ade_run_messages where run_id = ade_runs.id order by message_id))
		is not (select coalesce(json_group_array(value), '[]') from (select value from json_each(coalesce(
			(select record -> '$.state.outcome.result.held' from tasks where id = ade_runs.admit_id), '[]')) order by value))
union all select 'turns', id, 'missing' from tasks where kind = '"${GENERATION}"' and id not in (select id from ade_turns)
union all select 'turns', id, 'not in Pi' from ade_turns where id not in (select id from tasks)
union all select 'turns', ade_turns.id, 'ended in one, running in the other' from ade_turns join tasks using (id)
	where (ade_turns.status = 'running') != (tasks.status != 'terminal')
union all select 'spend', id, 'missing' from pi_call where id not in (select entry_id from ade_spend where entry_id is not null)
union all select 'spend', entry_id, 'not in Pi' from ade_spend where entry_id is not null and entry_id not in (select id from pi_call)
union all select 'spend', ade_spend.entry_id, 'turn or cost' from ade_spend join pi_call on pi_call.id = ade_spend.entry_id
	where ade_spend.turn_id is not pi_call.turn or abs(ade_spend.cost - coalesce(pi_call.cost, 0)) > 1e-9
union all select 'spend', documents.owner_id, 'a module''s calls or cost' from documents documents
	join document_revisions revisions on revisions.document_id = documents.id
	where documents.kind = '"${USAGE}"' and documents.retired_at is null
		and revisions.seq = (select max(seq) from document_revisions where document_id = documents.id)
		and (select json_array(coalesce(sum(calls), 0), round(coalesce(sum(cost), 0), 6)) from ade_spend
				where thread_id = documents.owner_id and entry_id is null)
			is not (select json_array(coalesce(sum(value ->> '$.calls'), 0), round(coalesce(sum(value ->> '$.cost'), 0), 6))
				from json_each(revisions.content, '$.buckets'))
union all select 'schedules', id, 'missing' from tasks where kind in (${quoted(SCHEDULED)}) and id not in (select id from ade_schedules)
union all select 'schedules', id, 'not in Pi' from ade_schedules where id not in (select id from tasks)
union all select 'schedules', ade_schedules.id, 'status, instructions or next run' from ade_schedules join tasks using (id)
	where (ade_schedules.status in ('waiting', 'paused')) != (tasks.status != 'terminal')
		or (ade_schedules.status = 'paused') != coalesce(tasks.record ->> '$.state.checkpoint.paused', 0)
		or ade_schedules.instructions is not coalesce(tasks.record ->> '$.state.checkpoint.instructions',
			tasks.record ->> '$.input.instructions', tasks.record ->> '$.input.note', '')
		or (tasks.status != 'terminal' and cast(strftime('%s', ade_schedules.next_run_at) as integer)
			is not (tasks.record ->> '$.state.until') / 1000)
union all select 'bots', null, 'differs' where
	(select coalesce(json_group_object(name, home_id), '{}') from (select * from ade_bots order by name))
	is not (select coalesce(json_group_object(key, value ->> '$.home'), '{}') from (select key, value from documents documents
		join document_revisions revisions on revisions.document_id = documents.id, json_each(revisions.content)
		where documents.kind = '"${BOTS}"' and documents.retired_at is null
			and revisions.seq = (select max(seq) from document_revisions where document_id = documents.id) order by key))
union all select 'messages', null, 'the search index holds another number of them'
	where (select count(*) from ade_messages) != (select count(*) from ade_messages_fts_docsize)
union all select "table", rowid, 'points at no ' || parent from pragma_foreign_key_check
`

/** How long one of our transactions stays open, in milliseconds, and how long the worker then leaves the database
 * alone, so a commit of Pi's that found it writing gets in */
const SLICE = 5
/** How often the commits Pi stored go into the tables, together: the fewer times we write, the fewer of Pi's commits
 * find us writing */
const BEAT = 50
const pause = new Int32Array(new SharedArrayBuffer(4))
/** How long the write-ahead log may get, in pages, before the worker has it start over: about 4 MB, where Pi's own
 * connection would move it into the database too */
const LOG_PAGES = 1000

/**
 * The worker: the one writer of the read model's tables, on a thread and a connection of its own, so its writes wait
 * for Pi's and never hold the server's thread. It takes, in order, `make` (the tables again from Pi's records as they
 * stand), each `publication` (one commit's records) and `check`, and tells the server each `state` and `seq`.
 */
function keep(file) {
	const db = open(file)
	const tell = (message) => parentPort.postMessage(message)
	let project
	let seq

	/**
	 * Moves what's been written from the write-ahead log into the database, here and not on Pi's next commit. Two
	 * writers taking turns can keep the log from ever starting over, so once it's long this waits for its turn and
	 * makes it: a pause for Pi's commits of as long as that copy takes, instead of a log that grows all day.
	 */
	function settle() {
		const { log } = /** @type {any} */ (db.prepare('pragma wal_checkpoint(passive)').get())
		if (log > LOG_PAGES) db.exec('pragma wal_checkpoint(restart)')
	}

	/** Pi's records at one commit, read whole on a connection of its own */
	function now() {
		const reader = new DatabaseSync(file, { readOnly: true })
		try {
			reader.exec('begin')
			return snapshot(reader)
		} finally {
			reader.close()
		}
	}

	function make() {
		const begun = performance.now()
		project = undefined
		tell({ state: 'being made', seq: null })
		try {
			const at = now()
			let since = performance.now()
			dropFrom(db)
			db.exec('begin immediate')
			project = fill(db, at, () => {
				if (performance.now() - since < SLICE) return
				db.exec('commit')
				settle()
				Atomics.wait(pause, 0, 0, SLICE)
				db.exec('begin immediate')
				since = performance.now()
			})
			db.exec('commit')
			settle()
			seq = at.seq
			const elapsed = Math.round(performance.now() - begun)
			tell({
				state: 'current',
				seq,
				...(elapsed >= 500 && {
					log: `read: made from Pi's records at commit ${seq} in ${elapsed} ms`,
				}),
			})
		} catch (error) {
			if (db.isTransaction) db.exec('rollback')
			project = undefined
			tell({
				state: `broken: it could not be made (${error.message})`,
				seq: null,
				error: String(error.stack),
			})
		}
	}

	/** Goes on from the tables as they are when they're true as of Pi's last commit, as a clean stop leaves them; else
	 * makes them again */
	function resume() {
		const reader = new DatabaseSync(file, { readOnly: true })
		try {
			reader.exec('begin')
			const ours = projectionOf(reader)
			if (ours?.version === version && ours.state === 'current' && ours.seq === piSeq(reader)) {
				project = projector(db)
				project.know({
					conversations: conversationsOf(reader),
					documents: documentsOf(reader, [AGENT]),
				})
				seq = ours.seq
			}
		} catch (error) {
			tell({ error: `read: could not go on from the tables (${error.message})` })
		} finally {
			// Closed before any making, whose checkpoints wait for every reader
			reader.close()
		}
		if (!project) return make()
		tell({ state: 'current', seq, log: `read: true as of Pi's commit ${seq}; kept as they are` })
	}

	/**
	 * Once Pi has closed: the tables true as of its last commit. Its close writes, unpublished, the tasks it stopped back
	 * as pending, which changes nothing here, where a task that hasn't ended is one that hasn't ended; so the next start
	 * keeps them.
	 */
	function closed() {
		if (!project) return
		const reader = new DatabaseSync(file, { readOnly: true })
		try {
			const last = piSeq(reader)
			if (last > seq) db.prepare('update ade_projection set seq = ?').run((seq = last))
		} finally {
			reader.close()
		}
	}

	/** Stops the tables being taken for current, and makes them again */
	function fail(why) {
		tell({ error: `read: ${why}; making the tables again` })
		try {
			if (db.isTransaction) db.exec('rollback')
			db.prepare('update ade_projection set state = ?').run(`broken: ${why}`)
		} catch {
			// The tables themselves may be what failed; they're replaced either way
		}
		make()
	}

	/** The commits Pi stored since the last beat, each with its records and the commit they're true as of */
	let stored = []
	let beat

	/** Those commits into the tables, and the commit they're now true as of, in one transaction or not at all */
	function apply() {
		beat = undefined
		const publications = stored
		stored = []
		// Not made, or already in what they were made from
		const next = publications.filter((publication) => project && publication.seq > seq)
		if (!next.length) return
		const gap = next.find((publication, at) => publication.seq !== (next[at - 1]?.seq ?? seq) + 1)
		if (gap) return fail(`commit ${gap.seq} did not follow the one before it`)
		try {
			db.exec('begin immediate')
			for (const publication of next) project.apply(publication.records)
			db.prepare('update ade_projection set seq = ?').run(next.at(-1).seq)
			db.exec('commit')
			if (Math.floor(next.at(-1).seq / 50) !== Math.floor(seq / 50)) settle()
			seq = next.at(-1).seq
			tell({ state: 'current', seq })
		} catch (error) {
			fail(`commits ${next[0].seq} to ${next.at(-1).seq} did not apply (${error.message})`)
		}
	}

	/**
	 * Compares the tables with Pi's records, both as one transaction sees them: `{seq, differences}`. While commits it
	 * hasn't applied yet are in sight it tries again; `moving` when that never stopped.
	 */
	function check(id, tries = 0) {
		const reader = new DatabaseSync(file, { readOnly: true })
		const fresh = open(':memory:')
		try {
			apply()
			reader.exec('begin')
			const ours = reader.prepare('select seq, state from ade_projection').get()
			const at = snapshot(reader)
			if (ours.state === 'current' && ours.seq !== at.seq) {
				if (tries < 100) return void setTimeout(() => check(id, tries + 1), 100)
				return tell({ id, checked: { moving: true, differences: [] } })
			}
			const differences =
				ours.state === 'current'
					? (fill(fresh, at), againstRebuild(reader, fresh))
					: [{ check: 'rebuild', table: 'projection', id: null, differs: ours.state }]
			const statements = FACTS.trim().split(';\n')
			for (const sql of statements.slice(0, -1)) reader.exec(sql)
			for (const row of reader.prepare(statements.at(-1)).all())
				differences.push({ check: 'pi', table: row.table_name, id: row.id, differs: row.differs })
			tell({ id, checked: { seq: at.seq, differences } })
		} catch (error) {
			tell({ id, checked: { error: error.message, differences: [] } })
		} finally {
			reader.close()
			fresh.close()
		}
	}

	parentPort.on('message', (message) => {
		if (message.start) resume()
		else if (message.make) make()
		else if (message.flush) {
			clearTimeout(beat)
			apply()
			closed()
			tell({ flushed: true })
		} else if (message.check) check(message.check)
		else if (message.publication) {
			stored.push(message.publication)
			beat ??= setTimeout(apply, BEAT)
		}
	})
}

if (!isMainThread && workerData?.read) keep(workerData.read.file)

/** The tables' own row, or none before they're first made */
function projectionOf(db) {
	try {
		return /** @type {any} */ (db.prepare('select version, seq, state from ade_projection').get())
	} catch {
		return undefined
	}
}

/** The read model, kept by a worker thread; `exact(job)` runs `job(all)` on the server's thread, `all(sql, ...params)`
 * answering rows, in one transaction that sees the tables true as of Pi's last commit, and answers what it does, or
 * nothing when they aren't, as while they're made or a twentieth of a second behind a commit. `recent(job)` is for a
 * read that can be a beat behind, as search: it also answers in that twentieth, and while the tables are made it waits
 * for them, answering nothing only if they couldn't be */
export function createRead(file) {
	let keeper
	let state = 'not made yet'
	let seq = null
	let asked = 0
	const checks = new Map()
	/** What waits for the tables while they're made */
	const waiting = []

	/** The worker, started with the tables' making */
	function kept() {
		if (keeper) return keeper
		keeper = new Worker(new URL(import.meta.url), { workerData: { read: { file } } })
		keeper.unref()
		keeper.on('message', (message) => {
			if (message.log) console.log(message.log)
			if (message.error) console.error(message.error)
			if (message.state) {
				state = message.state
				seq = message.seq
				if (state !== 'being made') for (const resolve of waiting.splice(0)) resolve()
			}
			if (message.checked) {
				checks.get(message.id)?.(message.checked)
				checks.delete(message.id)
			}
			if (message.flushed) flushed?.()
		})
		keeper.once('error', (error) => {
			console.error('read: its worker failed:', error)
			state = `broken: its worker failed (${error.message})`
			seq = null
			for (const resolve of waiting.splice(0)) resolve()
		})
		keeper.postMessage({ start: true })
		return keeper
	}

	/** Once Pi has closed, the commits told so far into the tables, so the next start keeps them */
	let flushed
	const flush = () =>
		new Promise((resolve) => {
			flushed = resolve
			kept().postMessage({ flush: true })
		})

	let reader
	const statements = new Map()
	function exact(job, behind = false) {
		reader ??= new DatabaseSync(file, { readOnly: true })
		const all = (sql, ...params) => {
			if (!statements.has(sql)) statements.set(sql, reader.prepare(sql))
			return statements.get(sql).all(...params)
		}
		reader.exec('begin')
		try {
			const ours = projectionOf(reader)
			if (
				ours?.version !== version ||
				ours.state !== 'current' ||
				(!behind && ours.seq !== piSeq(reader))
			)
				return undefined
			return job(all)
		} finally {
			reader.exec('commit')
		}
	}

	function committed(publication) {
		kept().postMessage({ publication: { seq: publication.seq, records: recordsOf(publication) } })
	}

	const check = () =>
		new Promise((resolve) => {
			checks.set(++asked, resolve)
			kept().postMessage({ check: asked })
		})
	async function checked() {
		const { seq: at, moving, error, differences } = await check()
		if (error) return console.error(`read: the check failed: ${error}`)
		if (moving)
			return console.log('read: the check found commits still landing; it runs again tomorrow')
		if (!differences.length)
			return console.log(`read: checked against Pi's records at commit ${at}: no differences`)
		console.error(`read: ${differences.length} differences from Pi's records at commit ${at}:`)
		for (const one of differences.slice(0, 20))
			console.error(`read:   ${one.check}  ${one.table}  ${one.id ?? ''}  ${one.differs}`)
	}

	function start() {
		setTimeout(checked, 60_000).unref()
		setInterval(checked, DAY).unref()
	}

	async function serve(threadId, query, body) {
		if (threadId !== undefined)
			throw new Error(
				'The read model is GET /api/read, GET /api/read?check and POST /api/read {rebuild: true}',
			)
		if (body !== undefined) {
			if (body.rebuild !== true) throw new Error('POST /api/read takes {rebuild: true}')
			kept().postMessage({ make: true })
			return { rebuilding: true }
		}
		if (query.has('check')) return check()
		const rows = {}
		if (state === 'current') {
			const db = new DatabaseSync(file, { readOnly: true })
			for (const table of Object.keys(TABLES))
				rows[table] = db.prepare(`select count(*) as rows from ade_${table}`).get().rows
			db.close()
		}
		return { file, state, seq, version, rows }
	}

	// Before any module starts and work resumes, so the tables are made from records no commit has yet followed
	kept()
	async function recent(job) {
		if (state === 'not made yet' || state === 'being made')
			await new Promise((resolve) => waiting.push(resolve))
		return exact(job, true)
	}

	return { committed, start, serve, flush, exact, recent }
}
