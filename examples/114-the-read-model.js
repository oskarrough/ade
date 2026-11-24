/** The house is plain SQL tables in ade's database, beside Pi's records, kept commit by commit, so sqlite3 answers who
 * said what, which run answered it and what that cost; a message taken back leaves no words there; after a kill they're
 * made again and the check finds them the same as Pi's records; and a clean stop leaves them for the next start */
import { DatabaseSync } from 'node:sqlite'
import {
	answered,
	api,
	check,
	db,
	done,
	kill,
	postEntry,
	say,
	scriptedRunner,
	server,
	until,
} from './lib.js'

const modules = { MODULES: '-auto-title,-memory' }
let srv = await server(modules)
await scriptedRunner('laptop', () => say('four'))
const file = db
const read = (sql, ...params) => {
	const store = new DatabaseSync(file, { readOnly: true })
	try {
		return store.prepare(sql).all(...params)
	} finally {
		store.close()
	}
}
const echo = { runner: 'laptop', model: 'echo/echo' }

const { id } = (await api('POST', '/api/threads', { title: 'sums' })).json
const asked = (await postEntry(id, 'two and two?', echo)).json.entry
await answered(id)
const story = await until(async () => {
	const rows = read(
		`select asked.author as person, asked.body as asked, answer.body as answer, runs.status, turns.status as turn,
			(select count(*) from ade_spend spend where spend.turn_id = runs.turn_id) as calls, threads.title
		from ade_runs runs
		join ade_threads threads on threads.id = runs.thread_id
		join ade_run_messages run_messages on run_messages.run_id = runs.id
		join ade_messages asked on asked.id = run_messages.message_id
		join ade_messages answer on answer.id = runs.answer_id
		join ade_turns turns on turns.id = runs.turn_id
		where asked.id = ?`,
		asked,
	)
	return rows[0]?.turn === 'completed' && rows
})
check(
	story.length === 1 &&
		story[0].title === 'sums' &&
		story[0].asked === 'two and two?' &&
		story[0].answer === 'four' &&
		story[0].status === 'answered' &&
		story[0].calls === 1,
	'one query joins a message to the run that took it, its answer, the turn that wrote it and its model calls',
	JSON.stringify(story),
)

const regretted = (await postEntry(id, 'my password is hunter2', [])).json.entry
await until(async () => read('select 1 from ade_messages messages where id = ?', regretted).length)
await api('POST', `/api/threads/${id}/withdraw`, { entry: regretted })
const gone = await until(async () => {
	const rows = read('select body, withdrawn from ade_messages messages where id = ?', regretted)
	return rows[0].withdrawn && rows
})
check(
	gone[0].body === '' &&
		!read(`select rowid from ade_messages_fts where ade_messages_fts match 'hunter2'`).length &&
		read(`select rowid from ade_messages_fts where ade_messages_fts match 'two'`).length === 1,
	'a message taken back keeps its row and loses its words, from search too',
	JSON.stringify(gone),
)

await kill(srv, 'SIGKILL')
srv = await server(modules)
const again = (await postEntry(id, 'and three and three?', echo)).json.entry
await answered(id, 2)
const both = await until(async () => {
	const rows = read(`select status from ade_runs runs where thread_id = ? order by id`, id)
	return rows.length === 2 && rows.every((row) => row.status === 'answered') && rows
})
const compared = await until(async () => {
	const result = (await api('GET', '/api/read?check')).json
	return !result.moving && result
}, 20000)
check(
	both.length === 2 &&
		read('select 1 from ade_messages messages where id = ?', again).length === 1 &&
		compared.differences.length === 0,
	"after a kill the tables are made again from Pi's records, go on from there, and the check finds no difference",
	JSON.stringify(compared),
)

const made = read('select built_at from ade_projection')[0].built_at
await kill(srv)
srv = await server(modules)
const kept = await until(async () => {
	const told = (await api('GET', '/api/read')).json
	return told.state === 'current' && told
})
check(
	read('select built_at from ade_projection')[0].built_at === made,
	"a clean stop leaves the tables true as of Pi's last commit, and the next start keeps them as they are",
	JSON.stringify(kept),
)
done()
