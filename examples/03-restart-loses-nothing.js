/** A restart loses nothing, and a runner that goes away is waited for */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	createThread,
	postEntry,
	answered,
	answers,
	api,
	brief,
	check,
	conversationOf,
	dir,
	done,
	kill,
	person,
	quiet,
	runner,
	server,
	settled,
	sleep,
	text,
	until,
	view,
} from './lib.js'

let srv = await server()
let laptop = await runner('laptop')

const id = await createThread('test')
await postEntry(id, 'hello', { runner: 'laptop', model: 'echo/echo' })
await answered(id)

laptop.kill()
await until(() => api('GET', '/api/runners').then((r) => r.json.every((x) => !x.online)))
await postEntry(id, 'while away', undefined, 'ben')
const inputs = async () =>
	(await conversationOf(await view(id), 'echo/echo@laptop')).entries
		.filter((e) => e.kind === 'ade.delivery')
		.map((e) => text(e.model[0]))
check(
	!(await inputs()).some((t) => t.includes('while away')),
	'the message is written, its delivery waits for the runner',
	JSON.stringify(await inputs()),
)
await kill(srv, 'SIGKILL')
srv = await server()
const queued = await view(id)
check(queued.status === 'blocked', 'after restart the delivery waits for the runner', queued.status)

// A stop closes Pi on its way out, quickly, and the delivery still waits
srv.kill('SIGTERM')
check(
	await Promise.race([new Promise((r) => srv.on('exit', () => r(true))), sleep(3000)]),
	'a stopped server closes and exits',
)
srv = await server()
check((await view(id)).status === 'blocked', 'after a stop the delivery still waits for the runner')

laptop = await runner('laptop', { wait: false })
const after = await answered(id, 2, 15000)
const ben = after?.entries.find((e) => e.data.author === person('ben'))
check(
	Boolean(ben) && answers(after).at(-1).data.re?.includes(ben.id),
	'after restart ben is answered and credited',
	brief(after),
)
await quiet()
check(
	answers(await view(id)).length === 2 &&
		(await inputs()).filter((t) => t.includes('while away')).length === 1,
	'delivered and answered once',
	JSON.stringify(await inputs()),
)

// A runner that goes away: the models pi has enabled in its folder are offered, and what it can't resolve is skipped
const awayDir = path.join(dir, 'away')
mkdirSync(path.join(awayDir, '.pi'), { recursive: true })
writeFileSync(
	path.join(awayDir, '.pi', 'settings.json'),
	JSON.stringify({ enabledModels: ['echo/e*', 'claude-bridge/claude-opus-5-5'] }),
)
const away = await runner('away', { dir: awayDir })
const offered = (await api('GET', '/api/runners')).json.find((x) => x.name === 'away')
check(
	JSON.stringify(offered?.offers) === '["echo/echo"]' && !offered.models.includes('echo/echo'),
	'a runner offers the models enabled in pi, unresolved',
	JSON.stringify(offered),
)
const gone = await createThread('away')
await postEntry(gone, 'hi', { runner: 'away', model: 'echo/echo' })
await answered(gone)
await api('POST', `/api/threads/${gone}/read`, {})
away.kill()
await until(() =>
	api('GET', '/api/runners').then((r) => r.json.some((x) => x.name === 'away' && !x.online)),
)
const unknown = await postEntry(gone, 'anyone?', { runner: 'away', model: 'other' })
check(
	unknown.status === 400 && /offline/.test(unknown.json.error),
	"an offline runner can't resolve a model it hasn't run",
	JSON.stringify(unknown),
)
// An agent is written with its model's own name, so that name finds a model the runner has run, even offline
const known = await postEntry(gone, 'anyone?', 'echo@away')
check(
	known.status === 201 && known.json.to?.join() === 'echo:off@away',
	'an offline runner knows a model it has run by its own name, as an agent is written',
	JSON.stringify(known),
)
check(
	Boolean(await until(async () => (await view(gone)).status === 'blocked')),
	'a thread waiting for an offline runner is blocked',
)
await api('POST', `/api/threads/${gone}/stop`, {})
const stopped = await settled(gone)
check(
	stopped?.status === 'idle' && !stopped.entries.some((e) => e.data.error),
	'a stopped thread is idle, with no error entry',
	`${stopped?.status} ${JSON.stringify(stopped?.entries)}`,
)

done()
