/**
 * MODULES=+schedule: an agent's scheduled task comes back to it after a restart, survives Stop, and × cancels one; a
 * task `after` another thread comes back once that thread's work ends, or at once if it has none
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

const env = { MODULES: '+schedule' }
let srv = await server(env)
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say(last.isError ? `failed: ${text(last)}` : 'set')
	const after = text(last).match(/^schedule after (\d+) (.*)/)
	if (after) return call('schedule', { after: Number(after[1]), instructions: after[2] })
	const asked = text(last).match(/^schedule (\S+) (.*)/)
	if (asked) return call('schedule', { in: asked[1], instructions: asked[2] })
	// Work runs until the example makes the file it names
	const work = text(last).match(/^work (\S+)/)
	return work
		? call('bash', { command: `until [ -e ${work[1]} ]; do sleep 0.05; done` })
		: say(`got: ${text(last)}`)
})
const id = await createThread('ci')
const postIn = (thread, body) => postEntry(thread, body, 'echo/echo@laptop')
const post = (body) => postIn(id, body)
const tasksIn = async (thread) => (await api('GET', `/api/threads/${thread}/schedule`)).json
const tasks = () => tasksIn(id)

await post('schedule 1h tidy the branch')
await answered(id)
await post('schedule 2s check CI on #412')
await answered(id, 2)
let pending = await tasks()
check(
	pending.length === 2 &&
		pending[0].instructions === 'check CI on #412' &&
		pending[0].at > Date.now(),
	'both tasks wait in the thread, the soonest first',
	JSON.stringify(pending),
)

await api('POST', `/api/threads/${id}/stop`, {})
check((await tasks()).length === 2, "Stop leaves the thread's scheduled tasks alone")

await kill(srv, 'SIGKILL')
const restarted = Date.now()
srv = await server(env)
const ran = await until(async () => {
	const thread = await view(id)
	const fired = thread.entries.find((entry) => entry.data.scheduledTask)
	const reply = fired && thread.entries.find((entry) => entry.id > fired.id && entry.data.answer)
	return reply && { fired, reply }
}, 15000)
check(
	ran?.fired.data.body === 'check CI on #412' &&
		Date.parse(ran.fired.data.createdAt) > restarted &&
		ran.reply.data.body.includes('scheduled-task') &&
		ran.reply.data.body.includes('check CI on #412'),
	'after a restart the task posts its instructions back to the agent, which answers it',
	JSON.stringify(ran),
)

pending = await tasks()
check(
	pending.length === 1 && pending[0].instructions === 'tidy the branch',
	'a task that ran is gone',
	JSON.stringify(pending),
)
const cancelled = await api('POST', `/api/threads/${id}/schedule`, { cancel: pending[0].id })
check(
	(await tasks()).length === 0 && cancelled.json.cancelled === pending[0].id,
	'× cancels the other',
	JSON.stringify(cancelled.json),
)
const late = await api('POST', `/api/threads/${id}/schedule`, {
	cancel: ran?.fired.data.scheduledTask,
})
check(
	late.json.fired === ran?.fired.data.scheduledTask,
	'cancelling a task that already ran says so',
	JSON.stringify(late.json),
)

// A review that opens once its fix lands
const fix = await createThread('fix')
const review = await createThread('review')
await postIn(fix, 'work fix-done')
await until(async () => (await view(fix)).status === 'working')
await postIn(review, `schedule after ${fix} review the fix`)
await answered(review)
const waiting = await tasksIn(review)
check(
	waiting.length === 1 &&
		waiting[0].schedule.after === fix &&
		(await view(fix)).status === 'working' &&
		!(await view(review)).entries.some((entry) => entry.data.scheduledTask),
	'a task after another thread waits while that thread works',
	JSON.stringify(waiting),
)
writeFileSync(path.join(dir, 'fix-done'), '')
const fixed = await answered(fix)
const opened = await until(async () =>
	(await view(review)).entries.find((entry) => entry.data.scheduledTask),
)
check(
	opened?.data.body === 'review the fix' &&
		Date.parse(opened.data.createdAt) >= Date.parse(answers(fixed).at(-1).data.createdAt),
	"once that thread's work ends, the task comes back",
	JSON.stringify(opened),
)
await answered(review, 2)
await postIn(review, `schedule after ${fix} look again`)
const again = await until(async () =>
	(await view(review)).entries.find(
		(entry) => entry.data.scheduledTask && entry.data.body === 'look again',
	),
)
check(Boolean(again), 'after a thread already idle, the task comes back at once')
check(
	(await tasksIn(review)).length === 0,
	'neither is pending any more',
	JSON.stringify(await tasksIn(review)),
)

// A thread that's archived still ends its work, and the task after it hears that
const shelved = await createThread('shelved')
await api('POST', `/api/threads/${shelved}/archive`, { archived: true })
await postIn(shelved, 'work shelved-done')
await until(async () => (await view(shelved)).status === 'working')
await postIn(review, `schedule after ${shelved} check the shelved one`)
await until(async () => (await tasksIn(review)).some((task) => task.schedule.after === shelved))
writeFileSync(path.join(dir, 'shelved-done'), '')
const shelvedRan = await until(async () =>
	(await view(review)).entries.find(
		(entry) => entry.data.scheduledTask && entry.data.body === 'check the shelved one',
	),
)
check(
	Boolean(shelvedRan) && !(await view(shelved)).busy,
	'a task after an archived thread comes back once its work ends',
	JSON.stringify((await view(review)).entries.at(-1)?.data),
)

// A page subscribed to the thread's schedule feed hears a task added and cancelled elsewhere
await answered(review, 5)
const heard = []
const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`)
socket.onmessage = ({ data }) => heard.push(JSON.parse(String(data)))
await new Promise((resolve) => (socket.onopen = resolve))
socket.send(JSON.stringify({ sub: `schedule/${review}` }))
await until(async () =>
	heard.some((message) => message.view === `schedule/${review}` && message.reset),
)
await postIn(review, 'schedule 1h later still')
const later = await until(async () => (await tasksIn(review))[0])
await until(async () =>
	heard.some(
		(message) =>
			message.view === `schedule/${review}` && message.put?.some((item) => item.key === later.id),
	),
)
heard.length = 0
await api('POST', `/api/threads/${review}/schedule`, { cancel: later.id })
check(
	Boolean(
		await until(async () =>
			heard.some(
				(message) => message.view === `schedule/${review}` && message.del?.includes(later.id),
			),
		),
	),
	'cancelling a task deletes it on the thread schedule feed',
	JSON.stringify(heard.slice(0, 5)),
)
socket.close()

done()
