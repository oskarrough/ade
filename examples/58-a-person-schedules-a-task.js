/**
 * MODULES=+schedule: a person schedules a task. Daily at 09:00 runs at 09:00 on the wall clock of the zone they chose,
 * pause takes its next run away and resume gives it back; a task in a thread arrives there as their own message, and
 * one for a new thread each run opens a child of the task's own thread, asking the model they picked. Run now runs one
 * at once; a timed run due while the last run's thread still works is skipped, and the list says so.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
	answered,
	api,
	check,
	createThread,
	call,
	dir,
	done,
	postEntry,
	say,
	scriptedRunner,
	server,
	text,
	until,
	view,
} from './lib.js'

await server({ MODULES: '+schedule' })
await scriptedRunner('laptop', (request) => {
	const last = request.messages.findLast((m) => m.role !== 'system')
	if (last.role === 'toolResult') return say('done')
	// Work runs until the example makes the file it names
	const work = text(last).match(/work (\S+)/)
	return work
		? call('bash', { command: `until [ -e ${work[1]} ]; do sleep 0.05; done` })
		: say(`got: ${text(last)}`)
})
const id = await createThread('mornings')
await postEntry(id, 'hello', 'echo/echo@laptop')
await answered(id)

const ZONE = 'Asia/Kolkata'
const clockIn = (ms) =>
	new Date(ms).toLocaleTimeString('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' })
const made = await api('POST', '/api/schedule', {
	instructions: 'write the brief',
	thread: id,
	repeat: 'daily',
	hour: 9,
	minute: 0,
	timeZone: ZONE,
})
const listed = async () =>
	(await api('GET', '/api/schedule')).json.find((task) => task.id === made.json.id)
const daily = await until(listed)
check(
	made.json.thread === id &&
		daily.schedule.repeat === 'daily' &&
		clockIn(daily.at) === '09:00' &&
		daily.at > Date.now() &&
		daily.at - Date.now() <= 86_400_000 &&
		clockIn(daily.from) === '09:00' &&
		daily.at - daily.from === 86_400_000,
	'daily at 9:00 runs next at 09:00 on the clock it was set in, filling from the run before',
	JSON.stringify({ made: made.json, daily }),
)

await api('POST', '/api/schedule', { pause: daily.id, note: 'on holiday' })
const paused = await until(async () => ((await listed())?.paused ? await listed() : undefined))
check(
	paused?.at === undefined && paused.note === 'on holiday',
	'paused, it has no next run and says why',
	JSON.stringify(paused),
)
await api('POST', `/api/threads/${id}/schedule`, { resume: daily.id })
const resumed = await until(async () => {
	const task = await listed()
	return task && !task.paused && task.at !== undefined && task
})
check(
	resumed?.at === daily.at && resumed.note === undefined,
	'resumed, its next run is back',
	JSON.stringify(resumed),
)

await api('POST', '/api/schedule', { run: daily.id })
const ranNow = await until(async () => (await listed())?.last)
const message = ranNow && (await view(id)).entries.find((entry) => entry.id === ranNow.entry)
check(
	message?.data.body === 'write the brief' &&
		message.data.scheduledTask === daily.id &&
		ranNow.thread === id &&
		(await listed()).at === daily.at,
	'run now posts it at once, the list links its last run, and its next run stays',
	JSON.stringify({ ranNow, message }),
)
await answered(id, 2)

await api('POST', '/api/schedule', { instructions: 'check the deploy', thread: id, in: '1s' })
const run = await until(async () =>
	(await view(id)).entries.find(
		(entry) => entry.data.scheduledTask && entry.data.body === 'check the deploy',
	),
)
const reply = await answered(id, 3)
check(
	run?.data.body === 'check the deploy' &&
		!run.data.author.includes('@') &&
		reply.entries.some(
			(entry) => entry.data.answer && entry.data.body.includes('check the deploy'),
		),
	"in a thread, it arrives as the person's own message, and the thread's agent answers",
	JSON.stringify(run),
)

// A run due while the last one's thread still works is skipped
const overlap = await createThread('overlap')
await postEntry(overlap, 'hello', 'echo/echo@laptop')
await answered(overlap)
const soon = (
	await api('POST', '/api/schedule', {
		instructions: 'work overlap-done',
		thread: overlap,
		every: '1m',
		in: '1s',
	})
).json
await api('POST', '/api/schedule', { run: soon.id })
await until(async () => (await view(overlap)).status === 'working')
const skipped = await until(async () => {
	const task = (await api('GET', `/api/threads/${overlap}/schedule`)).json.find(
		(one) => one.id === soon.id,
	)
	return task?.last?.skipped && task
})
check(
	Boolean(skipped) && skipped.at > Date.now(),
	"a timed run due while its last run's thread still works is skipped, and the list says so",
	JSON.stringify(skipped),
)
writeFileSync(path.join(dir, 'overlap-done'), '')

const fresh = await api('POST', '/api/schedule', {
	instructions: 'say hi',
	to: { runner: 'laptop', model: 'echo/echo' },
	in: '1s',
})
const child = await until(async () =>
	(await api('GET', '/api/threads')).json.find((row) => row.parent === fresh.json.thread),
)
const answer = child && (await answered(child.id))
check(
	Boolean(fresh.json.thread) &&
		answer?.entries.some((entry) => entry.data.scheduledTask && entry.data.body === 'say hi') &&
		answer.entries.some((entry) => entry.data.answer && entry.data.body.includes('say hi')),
	"a new thread each run opens under the task's own thread and asks the model picked",
	JSON.stringify({ fresh: fresh.json, child }),
)

done()
