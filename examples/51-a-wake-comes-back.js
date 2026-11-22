/**
 * MODULES=+wake: an agent's wake comes back to it after a restart, survives Stop, and × cancels one; a wake `after`
 * another thread comes back once that thread's work ends, or at once if it has none
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import {
	createThread,
	postEntry,
	base,
	answered,
	answers,
	api,
	call,
	check,
	dir,
	done,
	kill,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

const env = { MODULES: '+wake' }
let srv = await server(env)
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(last.isError ? `failed: ${text(last)}` : 'set')
	const after = text(last).match(/^wake after (\d+) (.*)/)
	if (after) return call('wake', { after: Number(after[1]), note: after[2] })
	const asked = text(last).match(/^wake (\S+) (.*)/)
	if (asked) return call('wake', { in: asked[1], note: asked[2] })
	// Work runs until the example makes the file it names
	const work = text(last).match(/^work (\S+)/)
	return work
		? call('bash', { command: `until [ -e ${work[1]} ]; do sleep 0.05; done` })
		: say(`got: ${text(last)}`)
})
const id = await createThread('ci')
const postIn = (thread, body) => postEntry(thread, body, 'echo/echo@laptop')
const post = (body) => postIn(id, body)
const wakesIn = async (thread) => (await api('GET', `/api/threads/${thread}/wake`)).json
const wakes = () => wakesIn(id)

await post('wake 1h tidy the branch')
await answered(id)
await post('wake 2s check CI on #412')
await answered(id, 2)
let pending = await wakes()
check(
	pending.length === 2 && pending[0].note === 'check CI on #412' && pending[0].at > Date.now(),
	'both wakes wait in the thread, the soonest first',
	JSON.stringify(pending),
)

await api('POST', `/api/threads/${id}/stop`, {})
check((await wakes()).length === 2, "Stop leaves the thread's wakes alone")

await kill(srv, 'SIGKILL')
const restarted = Date.now()
srv = await server(env)
const woke = await until(async () => {
	const thread = await view(id)
	const fired = thread.entries.find((entry) => entry.data.wake)
	const reply = fired && thread.entries.find((entry) => entry.id > fired.id && entry.data.answer)
	return reply && { fired, reply }
}, 15000)
check(
	woke?.fired.data.body === 'check CI on #412' &&
		Date.parse(woke.fired.data.createdAt) > restarted &&
		woke.reply.data.body.includes('wake') &&
		woke.reply.data.body.includes('check CI on #412'),
	'after a restart the wake posts its note back to the agent, which answers it',
	JSON.stringify(woke),
)

pending = await wakes()
check(
	pending.length === 1 && pending[0].note === 'tidy the branch',
	'a wake that fired is gone',
	JSON.stringify(pending),
)
const cancelled = await api('POST', `/api/threads/${id}/wake`, { cancel: pending[0].id })
check(
	(await wakes()).length === 0 && cancelled.json.cancelled === pending[0].id,
	'× cancels the other',
	JSON.stringify(cancelled.json),
)
const late = await api('POST', `/api/threads/${id}/wake`, { cancel: woke?.fired.data.wake })
check(
	late.json.fired === woke?.fired.data.wake,
	'cancelling a wake that already went off says so',
	JSON.stringify(late.json),
)

// A review that opens once its fix lands
const fix = await createThread('fix')
const review = await createThread('review')
await postIn(fix, 'work fix-done')
await until(async () => (await view(fix)).status === 'working')
await postIn(review, `wake after ${fix} review the fix`)
await answered(review)
const waiting = await wakesIn(review)
check(
	waiting.length === 1 &&
		waiting[0].after === fix &&
		(await view(fix)).status === 'working' &&
		!(await view(review)).entries.some((entry) => entry.data.wake),
	'a wake after another thread waits while that thread works',
	JSON.stringify(waiting),
)
writeFileSync(path.join(dir, 'fix-done'), '')
const fixed = await answered(fix)
const opened = await until(async () =>
	(await view(review)).entries.find((entry) => entry.data.wake),
)
check(
	opened?.data.body === 'review the fix' &&
		Date.parse(opened.data.createdAt) >= Date.parse(answers(fixed).at(-1).data.createdAt),
	"once that thread's work ends, the wake comes back",
	JSON.stringify(opened),
)
await answered(review, 2)
await postIn(review, `wake after ${fix} look again`)
const again = await until(async () =>
	(await view(review)).entries.find((entry) => entry.data.wake && entry.data.body === 'look again'),
)
check(Boolean(again), 'after a thread already idle, the wake comes back at once')
check(
	(await wakesIn(review)).length === 0,
	'neither is pending any more',
	JSON.stringify(await wakesIn(review)),
)

// A thread that's archived still ends its work, and the wake after it hears that
const shelved = await createThread('shelved')
await api('POST', `/api/threads/${shelved}/archive`, { archived: true })
await postIn(shelved, 'work shelved-done')
await until(async () => (await view(shelved)).status === 'working')
await postIn(review, `wake after ${shelved} check the shelved one`)
await until(async () => (await wakesIn(review)).some((wake) => wake.after === shelved))
writeFileSync(path.join(dir, 'shelved-done'), '')
const shelvedWoke = await until(async () =>
	(await view(review)).entries.find(
		(entry) => entry.data.wake && entry.data.body === 'check the shelved one',
	),
)
check(
	Boolean(shelvedWoke) && !(await view(shelved)).busy,
	'a wake after an archived thread comes back once its work ends',
	JSON.stringify((await view(review)).entries.at(-1)?.data),
)

// A page watching the thread hears a wake cancelled elsewhere
await answered(review, 5)
const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.onmessage = ({ data }) => heard.push(JSON.parse(String(data)))
await new Promise((resolve) => (socket.onopen = resolve))
socket.send(JSON.stringify({ watch: review }))
await postIn(review, 'wake 1h later still')
const later = await until(async () => (await wakesIn(review))[0])
heard.length = 0
await api('POST', `/api/threads/${review}/wake`, { cancel: later.id })
check(
	Boolean(
		await until(async () =>
			heard.some((message) => message.thread === review && message.activity?.purpose === 'wake'),
		),
	),
	'cancelling a wake tells the pages watching its thread',
	JSON.stringify(heard.slice(0, 5)),
)
socket.close()

done()
