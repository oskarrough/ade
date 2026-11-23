/**
 * MODULES=+check: a scheduled task's check runs before each run, as the agent the run asks, with its tools and no model.
 * Quiet, the run asks no one and is kept as checked; `post` asks, with what it found beside the instructions; `keep`
 * carries its state to the next run, across a restart; `done` ends the task; it can't schedule. A check that fails
 * three times running pauses its task, saying why.
 *
 * post, done and keep are Code Mode globals that pi-durable marks internal: this example is what tells an upgrade that
 * broke them.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	createThread,
	dir,
	done,
	kill,
	postEntry,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

const env = { MODULES: '+check' }
let srv = await server(env)
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	return say(`got: ${text(last)}`)
})
const id = await createThread('builds')
await postEntry(id, 'hello', 'echo/echo@laptop')
await answered(id)

const SCRIPT = String.raw`
const n = (input.state ?? 0) + 1
keep(n)
let refused = ''
try {
	await tools.schedule({ instructions: 'again', in: '5m' })
} catch (error) {
	refused = error.message
}
console.log('run', n, 'after', input.runs, refused)
if (n === 2) post('build ' + (await tools.bash({ command: 'cat build' })).output.trim())
if (n === 3) done()
`
const made = await api('POST', '/api/schedule', {
	instructions: 'look at the build',
	thread: id,
	every: '1h',
	check: SCRIPT,
})
const task = made.json.id
const listed = async (one = task) =>
	(await api('GET', '/api/schedule')).json.find((each) => each.id === one)
const runs = async (one = task) => (await listed(one))?.runs ?? []
const posts = async () => (await view(id)).entries.filter((entry) => entry.data.scheduledTask)
check(
	made.status === 201 && (await until(listed))?.check === SCRIPT.trim(),
	'a person sets a task with a check, and the list shows it',
	JSON.stringify(made.json),
)

await api('POST', '/api/schedule', { run: task })
const quiet = await until(async () => (await runs()).at(-1)?.checked && (await runs()).at(-1))
check(
	quiet.checked === 1 &&
		quiet.output.includes('run 1 after 0') &&
		quiet.output.includes("A check can't schedule tasks") &&
		(await posts()).length === 0,
	"quiet, the check asks no one and its run keeps what it printed; it can't schedule",
	JSON.stringify(quiet),
)

writeFileSync(path.join(dir, 'build'), 'red')
await api('POST', '/api/schedule', { run: task })
const [posted] = await until(async () => (await posts()).length && (await posts()))
const read = await until(async () =>
	(await view(id)).entries.find(
		(entry) => entry.data.answer && entry.data.body.includes('<check-found>'),
	),
)
check(
	posted.data.body === 'look at the build' &&
		posted.data.checked === 'build red' &&
		read.data.body.includes('build red') &&
		(await runs()).at(-1).thread === id,
	'post asks, with what the check found on the runner beside the instructions',
	JSON.stringify({ posted, read: read?.data.body }),
)

await kill(srv, 'SIGKILL')
srv = await server(env)
await until(listed)
await api('POST', '/api/schedule', { run: task })
await until(async () => !(await listed()), 15_000)
const ended = (await api('GET', `/api/threads/${id}/trail`)).json
check(
	(await posts()).length === 1 && JSON.stringify(ended).includes('its check said done'),
	'what it kept survives a restart, and done ends the task',
	JSON.stringify(ended.slice(-4)),
)

const failing = (
	await api('POST', '/api/schedule', {
		instructions: 'never asked',
		thread: id,
		every: '1h',
		check: "throw new Error('no build server')",
	})
).json.id
for (let tries = 1; tries <= 3; tries++) {
	await api('POST', '/api/schedule', { run: failing })
	await until(async () => (await runs(failing)).length === tries)
}
const stopped = await until(async () => (await listed(failing))?.paused && (await listed(failing)))
check(
	stopped.runs.every((run) => run.failed?.includes('no build server')) &&
		stopped.note.includes('its check failed 3 times') &&
		(await posts()).length === 1,
	'a check that fails three times running pauses its task, saying why',
	JSON.stringify(stopped),
)

const refused = await api('POST', '/api/schedule', {
	instructions: 'x',
	to: { runner: 'laptop', model: 'echo/echo' },
	every: '1h',
	check: 'post("hi")',
})
check(
	refused.status === 400 && /no agent to check as/.test(refused.json.error),
	'a task that starts a new thread each run has no agent to check as, so no check',
	JSON.stringify(refused.json),
)
done()
