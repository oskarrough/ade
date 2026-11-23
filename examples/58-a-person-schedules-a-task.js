/**
 * MODULES=+schedule: a person schedules a task. Daily at 09:00 runs at 09:00 on the wall clock of the zone they chose,
 * pause takes its next run away and resume gives it back; an edit changes what it says and when, keeping its runs; a task in a thread arrives there as their own message, and
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
	times: ['09:00'],
	timeZone: ZONE,
})
const listed = async () =>
	(await api('GET', '/api/schedule')).json.find((task) => task.id === made.json.id)
const daily = await until(listed)
check(
	made.json.thread === id &&
		daily.schedule.times.join() === '09:00' &&
		daily.schedule.days === undefined &&
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
const ranNow = await until(async () => (await listed())?.runs.at(-1))
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

// Weekdays at 09:00 and 17:30, in its own words now: the same task, its runs kept, its next run on the new clock
const weekday = (ms) =>
	new Date(ms).toLocaleDateString('en-GB', { timeZone: ZONE, weekday: 'short' })
const edited = await api('POST', '/api/schedule', {
	edit: daily.id,
	instructions: 'write the short brief',
	times: ['17:30', '09:00'],
	days: ['mon', 'tue', 'wed', 'thu', 'fri'],
	timeZone: ZONE,
})
const changed = await until(async () => {
	const task = await listed()
	return task?.instructions === 'write the short brief' && task
})
check(
	edited.json.edited === daily.id &&
		changed.schedule.times.join() === '09:00,17:30' &&
		changed.schedule.days.join() === '1,2,3,4,5' &&
		['09:00', '17:30'].includes(clockIn(changed.at)) &&
		!['Sat', 'Sun'].includes(weekday(changed.at)) &&
		changed.runs.at(-1)?.entry === ranNow.entry,
	'an edit changes its instructions and its clock in place, and keeps its runs',
	JSON.stringify({ edited: edited.json, changed }),
)

await api('POST', '/api/schedule', { run: daily.id })
const twice = await until(async () => {
	const steps = (await api('GET', `/api/threads/${id}/trail`)).json.filter(
		(step) => step.kind === 'fired' && step.task === daily.id,
	)
	return steps.length === 2 && steps
})
check(
	twice[0].instructions === 'write the brief' &&
		twice[0].schedule.times.join() === '09:00' &&
		twice[1].instructions === 'write the short brief' &&
		twice[1].schedule.times.join() === '09:00,17:30' &&
		twice[1].recipients.length === 1,
	"each run's step in the trail keeps the task as it stood then: what it said, when it ran and whom it asked",
	JSON.stringify(twice),
)

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
	return task?.runs.at(-1)?.skipped && task
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
