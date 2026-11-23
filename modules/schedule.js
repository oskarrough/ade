/**
 * Scheduled tasks: instructions that arrive in a thread later, once, every so often, by the clock, once another thread's
 * work ends, when something happens in ade, or on an outside event. On by default; MODULES=-schedule turns it off.
 *
 * An agent sets one with `schedule`; its instructions come back to it, as it, marked `scheduledTask`. A person sets one
 * from the Scheduled tasks list (POST /api/schedule): it runs in a bot's home, asking her; in a thread, carrying its own
 * `recipients` (keys into that thread's agents, a bot's name or `agent` for its own; left out, everyone there, worked
 * out fresh each run so the director never guesses for it); or in a new thread each run, a child of the task's own
 * thread, asking the agent they chose.
 *
 * Each is an `ade.scheduled-task` task owned by its thread in the background: a stored sleep, so it survives a restart
 * and the thread's Stop, and holds no process. Its schedule is `{at}` once, `{at, every}` every so often from its first
 * run, `{times, days?, timeZone}` at clock times on chosen weekdays by the wall clock (so a clock change keeps it at
 * 7:30), `{after}` a thread, `{when}` something happens in ade, or `{on}` an event: Temporal's shapes, none of its
 * weight; client clock.js works them out. A repeating one can end, as a Temporal schedule's `endAt` and
 * `remainingActions` do: `until` a time, or after `count` runs; its last run, or its end time passing, writes an
 * `ended` step in the trail.
 * One that came due while the server was down runs once on start; a repeating one skips the runs it missed. A timed run
 * due while the previous run's thread still works is skipped, and kept among its `runs` with why: the runners that run
 * waits for, offline, or the run before still working.
 *
 * Pause (with an optional note), resume, run now and edit are Control signals it sleeps on beside its time, one key
 * each (`control-N`): paused, it sleeps on the next key only; resumed, it sleeps until its next run from now; run now
 * posts once, outside its schedule; an edit's instructions, schedule and model live in its checkpoint from then on
 * (current). A webhook task, paused, refuses events.
 *
 * A task `after` thread N sleeps on Ended. When the server hears a thread's work end (`ended`), and once on start,
 * settle signals each such task whose thread has no work left (core.busy); one set while N is already idle runs at once.
 * With hooks on, one `on` an outside event (hooks.js) sleeps on its next Hooked signal and posts each event beside its
 * instructions as `event`, which the agent reads as outside data.
 *
 * A task `when` something happens sleeps on Happened, runs once and ends, like `after`: `{online}` or `{offline}`, a
 * runner by name, when it connects or drops (at once if it already is, on set and on start); `{failed}` or
 * `{answered}`, a thread, the next time a run there fails or an agent there answers, as its trail says (entryStored).
 * Nothing polls: the server tells the module (runner, entryStored) and it signals the tasks waiting on just that.
 *
 * A run, or a run skipped, is a step in its thread's
 * trail; every change tells every page (`schedule` changed). Archiving a thread cancels its tasks.
 *
 * With check on, as it is by default, a task may carry a `check` (check.js): when it comes due, run now included, it waits on the check
 * first, as the agent the run asks, and posts only if the check said `post`, with what it found beside the
 * instructions (`checked`). A quiet check is a run too, counted toward `count`, kept among its runs (quiet ones in a
 * row as one) and in the trail; one that fails is kept with why, and STRIKES in a row pause the task with a note.
 * `done` ends the task after the run.
 */
import { arr, bool, num, obj, opt, str, unknown } from '@earendil-works/pi-schema'
import { defineExtension, defineSignal, defineTask, defineTool } from '@earendil-works/pi-durable'
import { background, finished, writtenTo } from '../util.js'
import { defaultTitle } from '../apps/client/title.js'
import { clockTime, DAYS, instant, lastRun, nextRun, span } from '../apps/client/clock.js'
import { EVENTS, Hooked, issue } from './hooks.js'
import { CheckRun, MOST, outcomeOf } from './check.js'

export const on = true

const UNITS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
/** The shortest repeat, so a routine can't fill a thread */
const EVERY = 60_000
/** The server's own time zone, which an agent's clock times are in */
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** `90s`, `5m`, `1h30m`, `2d` → milliseconds */
export function duration(text, name) {
	const parts = String(text)
		.replace(/\s+/g, '')
		.match(/^(?:\d+[smhd])+$/)
	if (!parts) throw new Error(`${name} is a duration like 90s, 5m, 1h30m or 2d`)
	let ms = 0
	for (const [, count, unit] of String(text).matchAll(/(\d+)\s*([smhd])/g))
		ms += Number(count) * UNITS[unit]
	if (!ms) throw new Error(`${name} must be longer than nothing`)
	return ms
}

/**
 * When a task runs: `{at}` once, `{at, every}` every so often from its first run, `{times, days?, timeZone}` at clock
 * times on chosen weekdays, `{after}`, `{when}` or `{on}`; a repeating one ends `until` a time or after `count` runs
 * @typedef {{ at?: number, every?: number, times?: string[], days?: number[], timeZone?: string, after?: number, on?: string, when?: When, until?: number, count?: number }} Schedule
 */

/**
 * What a task waits for inside ade, one of: a runner coming `online` or going `offline`, by name, or a thread whose next
 * run `failed` or that `answered`, by id
 * @typedef {{ online?: string, offline?: string, failed?: number, answered?: number }} When
 */

/** A timed schedule's next run after the one at `at`, from `now`, skipping those missed; none for a one-off */
function following(schedule, at, now) {
	if (schedule.times) return nextRun(schedule, now)
	if (!schedule.every) return undefined
	return at + Math.max(1, Math.ceil((now - at) / schedule.every)) * schedule.every
}

/** Weekdays, `mon` or 1, Sunday 0, in week order */
function weekdays(days) {
	const list = Array.isArray(days)
		? days
		: String(days)
				.split(/[\s,]+/)
				.filter(Boolean)
	const index = list.map((day) =>
		/^\d$/.test(String(day)) ? Number(day) : DAYS.indexOf(String(day).slice(0, 3).toLowerCase()),
	)
	if (!index.length || index.some((day) => day < 0 || day > 6))
		throw new Error('days is a list of mon … sun')
	return [...new Set(index)].sort()
}

/** Clock times, `09:00`, sorted, each once */
function clockTimes(times) {
	const list = Array.isArray(times)
		? times
		: String(times)
				.split(/[\s,]+/)
				.filter(Boolean)
	const read = list.map(clockTime)
	if (!list.length || list.length > 24 || read.some((time) => !time))
		throw new Error('times is a list of clock times like 09:00 and 17:30, at most 24')
	const two = (number) => String(number).padStart(2, '0')
	return [...new Set(read.map(([hour, minute]) => `${two(hour)}:${two(minute)}`))].sort()
}

/** A moment: milliseconds, an ISO time with its offset, or `2026-11-24T09:00` on the clock in `timeZone` */
function moment(value, timeZone, name = 'at') {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})$/.exec(String(value).trim())
	if (local) {
		const [, year, month, day, hour, minute] = local.map(Number)
		return instant(year, month - 1, day, hour, minute, timeZone)
	}
	const ms = Date.parse(String(value))
	if (Number.isNaN(ms)) throw new Error(`${name} is a date and time like 2026-11-24T09:00`)
	return ms
}

/** A time zone Intl knows */
function zone(timeZone) {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone })
		return timeZone
	} catch {
		throw new Error(`No time zone ${timeZone}`)
	}
}

/** What a request says about when: the fields scheduleOf reads */
const WHEN = ['in', 'at', 'every', 'times', 'days', 'after', 'when', 'on', 'until', 'count']
/** What `when` can wait for: a runner's name, or a thread's id */
const HAPPENINGS = {
	online: 'runner',
	offline: 'runner',
	failed: 'thread',
	answered: 'thread',
}

/** `when` in words: when vps comes online, when thread 12 fails */
export const happening = (when) =>
	when.online !== undefined
		? `when ${when.online} comes online`
		: when.offline !== undefined
			? `when ${when.offline} goes offline`
			: when.failed !== undefined
				? `when thread ${when.failed} fails`
				: `when thread ${when.answered} answers`

/**
 * A schedule from what a person or an agent asked: `in` or `at` once; `every` from `at`, or after `in` or `every`;
 * `times` on `days` (every day if left out) in `timeZone`; `after` a thread; `when` something happens; `on` an event.
 * One that repeats can end `until` a time (or a duration from now) or after `count` runs.
 */
/** @returns {Promise<Schedule>} */
async function scheduleOf(asked, { core, hooks, threadId, now = Date.now() }) {
	const { until, count, ...rest } = asked
	const schedule = await startOf(rest, { core, hooks, threadId, now })
	if (until === undefined && count === undefined) return schedule
	if (!schedule.every && !schedule.times && schedule.on === undefined)
		throw new Error('until and count end a task that repeats: every, times or on')
	const ending = {}
	if (count !== undefined) {
		const runs = Number(count)
		if (!Number.isInteger(runs) || runs < 1) throw new Error('count is how many runs, at least 1')
		ending.count = runs
	}
	if (until !== undefined) {
		const end = /^\s*(?:\d+\s*[smhd]\s*)+$/.test(String(until))
			? now + duration(until, 'until')
			: moment(until, schedule.timeZone ?? ZONE, 'until')
		const first = schedule.on === undefined ? firstRun(schedule, now) : now
		if (!(end > first)) throw new Error('until comes after its first run')
		ending.until = end
	}
	return { ...schedule, ...ending }
}

/** When a task starts, from what was asked, without its end */
/** @returns {Promise<Schedule>} */
async function startOf(asked, { core, hooks, threadId, now }) {
	const given = WHEN.filter((name) => asked[name] !== undefined)
	const only = (allowed, message) => {
		if (given.some((name) => !allowed.includes(name))) throw new Error(message)
	}
	if (asked.on !== undefined) {
		if (!hooks) throw new Error('A task on an event needs hooks on')
		if (!(asked.on in EVENTS)) throw new Error('on is push, ci or hook')
		only(['on'], 'on runs on events, at no time: leave the time out')
		return { on: asked.on }
	}
	if (asked.when !== undefined) {
		only(['when'], 'when runs once, at no time: leave the time out')
		const what = typeof asked.when === 'object' && asked.when ? Object.keys(asked.when) : []
		if (what.length !== 1 || !(what[0] in HAPPENINGS))
			throw new Error('when is one of online or offline, a runner, or failed or answered, a thread')
		const [name] = what
		const value = asked.when[name]
		if (HAPPENINGS[name] === 'runner') {
			if (typeof value !== 'string' || !(value in (await core.known())))
				throw new Error(`No runner ${value}`)
			return { when: { [name]: value } }
		}
		const id = Number(value)
		if (id === threadId) throw new Error(`${name} is another thread`)
		if (!Number.isInteger(id) || !(await core.thread(id))) throw new Error(`No thread ${value}`)
		return { when: { [name]: id } }
	}
	if (asked.after !== undefined) {
		only(['after'], 'after runs once, at no time: leave the time out')
		if (asked.after === threadId) throw new Error('after is another thread')
		if (!(await core.thread(asked.after))) throw new Error(`No thread ${asked.after}`)
		return { after: asked.after }
	}
	const timeZone = zone(asked.timeZone ?? ZONE)
	if (asked.times !== undefined || asked.days !== undefined) {
		only(['times', 'days'], 'times are clock times: leave in, at and every out')
		if (asked.times === undefined) throw new Error('days need times, like 09:00')
		const days = asked.days === undefined ? undefined : weekdays(asked.days)
		return {
			times: clockTimes(asked.times),
			...(days && days.length < 7 ? { days } : {}),
			timeZone,
		}
	}
	if (asked.in !== undefined && asked.at !== undefined) throw new Error('give in or at, not both')
	const at = asked.at === undefined ? undefined : moment(asked.at, timeZone)
	if (asked.every !== undefined) {
		const every = duration(asked.every, 'every')
		if (every < EVERY) throw new Error('every is at least 1m')
		return {
			at: at ?? now + (asked.in === undefined ? every : duration(asked.in, 'in')),
			every,
		}
	}
	if (at !== undefined) {
		if (at <= now) throw new Error('at is in the past')
		return { at }
	}
	if (asked.in === undefined) throw new Error('give in, at, every, times, after, when, or on')
	return { at: now + duration(asked.in, 'in') }
}

const Ended = defineSignal({
	name: 'ade.thread-ended',
	version: 1,
	schema: obj({}),
})
/** What a task `when` waits for came to pass */
const Happened = defineSignal({
	name: 'ade.happened',
	version: 1,
	schema: obj({}),
})
/** Pause (with a note why), resume or run now, on the next `control-N` key the task sleeps on */
const Control = defineSignal({
	name: 'ade.scheduled-task-control',
	version: 1,
	schema: obj({
		paused: opt(bool()),
		note: opt(str()),
		run: opt(bool()),
		runner: opt(str()),
		edit: opt(unknown()),
	}),
})

/** How many past runs a task keeps */
const RUNS = 5
/** How many failed checks in a row pause a task */
const STRIKES = 3

/** What a task does now: what it was set to, with what edits changed since */
const current = (input, checkpoint) => ({
	...input,
	...(checkpoint?.schedule ? { schedule: checkpoint.schedule } : {}),
	...(checkpoint?.instructions ? { instructions: checkpoint.instructions } : {}),
	...(input.to !== undefined && checkpoint?.to ? { to: checkpoint.to } : {}),
	...(checkpoint?.recipients !== undefined ? { recipients: checkpoint.recipients } : {}),
	...(checkpoint?.check !== undefined ? { check: checkpoint.check || undefined } : {}),
})

/** Its first run from `now`: by the clock or every so often, the next one due; once, its time */
const firstRun = (schedule, now) =>
	schedule.times || schedule.every ? nextRun(schedule, now) : schedule.at

/** When a task wakes by the clock: its next run, or its end time if that comes first or it has no run by time */
const wakeAt = (schedule, checkpoint) =>
	checkpoint.paused || checkpoint.at === undefined
		? schedule.until
		: Math.min(checkpoint.at, schedule.until ?? Infinity)

/**
 * What a task sleeps on at `checkpoint`: its next run's time or its end, its next event, Ended or Happened, and its
 * next Control key
 */
const asleep = (schedule, checkpoint) => ({
	status: /** @type {const} */ ('sleeping'),
	...(wakeAt(schedule, checkpoint) === undefined ? {} : { until: wakeAt(schedule, checkpoint) }),
	signals: [
		Control.key(`control-${checkpoint.c}`),
		...(checkpoint.paused
			? []
			: schedule.on !== undefined
				? [Hooked.key(`event-${checkpoint.n}`)]
				: schedule.after !== undefined
					? [Ended.key('ended')]
					: schedule.when !== undefined
						? [Happened.key('happened')]
						: []),
	],
	checkpoint,
})

/** Why a task ends with this run: `ran` runs used up its count, or its next run `at` comes after its end time */
const endOf = (schedule, ran, at) =>
	schedule.count !== undefined && ran >= schedule.count
		? `its last of ${schedule.count} run${schedule.count === 1 ? '' : 's'}`
		: schedule.until !== undefined && at !== undefined && at > schedule.until
			? 'its end time comes before another run'
			: undefined

export function server(core) {
	const hooks = core.modulesOn.includes('hooks')
	const checking = core.modulesOn.includes('check')
	/** Scheduled tasks in one thread or all, `sleeping` or not yet (`pending`); those already cancelled are gone */
	const sleeping = async (threadId, status = 'sleeping') =>
		(
			await core.tasks({
				...(threadId === undefined ? {} : { conversationId: threadId }),
				kind: ScheduledTask.definition.name,
				status,
			})
		).filter((record) => !record.abortRequested)

	/**
	 * The thread's scheduled tasks, or the whole house's, the soonest first, then the paused and those waiting on a thread
	 * or an event: `{id, thread, schedule, at?, from?, paused?, note?, runs, ran?, instructions, by, agent?, bot?, to?}`.
	 * `at` is its next run, `from` where the wait for it began: the run before, or when a one-off was set. `runs` are
	 * its last few, oldest first, each `{at, thread, entry}` or `{at, skipped}`, why it was skipped; `ran`, for one
	 * that ends after a `count`, how many it has run; `note` why it's paused.
	 */
	async function pending(threadId) {
		return [...(await sleeping(threadId)), ...(await sleeping(threadId, 'waiting'))]
			.map(({ id, conversationId, input: set, state, startedAt }) => {
				const { checkpoint } = /** @type {any} */ (state)
				const input = current(set, checkpoint)
				const at = checkpoint.paused ? undefined : checkpoint.at
				const { schedule } = input
				const from =
					at === undefined
						? undefined
						: schedule.times
							? lastRun(schedule, at)
							: schedule.every
								? at - schedule.every
								: (checkpoint.since ?? startedAt)
				return {
					id,
					thread: conversationId,
					schedule,
					...(at === undefined ? {} : { at, from }),
					...(checkpoint.paused ? { paused: true } : {}),
					...(checkpoint.paused && checkpoint.note ? { note: checkpoint.note } : {}),
					runs: checkpoint.runs ?? [],
					...(schedule.count === undefined ? {} : { ran: checkpoint.ran ?? 0 }),
					instructions: input.instructions,
					by: input.by,
					...(input.conversation === undefined ? {} : { agent: input.by }),
					...(input.bot === undefined ? {} : { bot: input.bot }),
					...(input.to === undefined ? {} : { to: input.to }),
					...(input.recipients === undefined ? {} : { recipients: input.recipients }),
					...(input.check ? { check: input.check } : {}),
				}
			})
			.sort(
				(left, right) =>
					(left.at ?? Infinity) - (right.at ?? Infinity) || (left.id ?? 0) - (right.id ?? 0),
			)
	}

	/** Each task still to run, sleeping or not yet, with what it waits on now */
	async function waiting() {
		// A task just set may not sleep yet; Pi keeps a signal that comes first
		return [...(await sleeping()), ...(await sleeping(undefined, 'pending'))].map((record) => ({
			id: record.id,
			schedule: current(record.input, /** @type {any} */ (record.state).checkpoint).schedule,
		}))
	}

	/** Runs each task after `threadId`, or after any thread, whose thread has no work left; `duplicate` is fine */
	async function settle(threadId) {
		const idle = new Map()
		for (const { id, schedule } of await waiting()) {
			const { after } = schedule
			if (after === undefined || (threadId !== undefined && after !== threadId)) continue
			if (!idle.has(after)) idle.set(after, !(await core.busy(after)))
			if (idle.get(after)) await core.signal(id, Ended, 'ended', {})
		}
	}
	const settling = (threadId) => settle(threadId).catch((error) => console.error(error))

	/** Wakes each task `when` that `holds` for */
	async function happen(holds) {
		for (const { id, schedule } of await waiting())
			if (schedule.when !== undefined && holds(schedule.when))
				await core.signal(id, Happened, 'happened', {})
	}
	const waking = (holds) => happen(holds).catch((error) => console.error(error))
	/** A runner already as a task waits for it to be: online, or offline */
	const already = (when) =>
		when.online !== undefined
			? core.runners.isOnline(when.online)
			: when.offline !== undefined && !core.runners.isOnline(when.offline)
	/** A task just set or edited whose wait is already over runs at once */
	const settleNew = (schedule) => {
		if (schedule.after !== undefined) settling(schedule.after)
		if (schedule.when !== undefined && already(schedule.when)) waking(already)
	}

	/** A scheduled task by id, in `threadId` if given, or a 404 */
	async function find(threadId, id) {
		const record = await core.task(id)
		if (
			record?.kind !== ScheduledTask.definition.name ||
			(threadId !== undefined && record.conversationId !== threadId)
		)
			throw Object.assign(
				new Error(
					`No scheduled task ${id}${threadId === undefined ? '' : ` in thread ${threadId}`}`,
				),
				{ status: 404 },
			)
		return record
	}

	/**
	 * Cancels one, and says what came of it: `{cancelled}`, or `{fired}` for a one-off that ran first, `{ended}` for
	 * one that ended otherwise
	 */
	async function cancel(threadId, id) {
		await find(threadId, id)
		if ((await core.abortTask(id)) === 'marked') await core.waitForTask(id)
		const outcome = /** @type {any} */ ((await core.task(id))?.state)?.outcome
		if (outcome?.status === 'aborted') return { cancelled: id }
		return outcome?.result?.fired ? { fired: id } : { ended: id }
	}

	/**
	 * Pauses one, with an optional note why, resumes it, or runs it now: `{paused}`, `{resumed}` or `{ran}` once it has
	 * the word; it acts in its next phase, and its pages hear when
	 */
	async function control(threadId, id, word) {
		const record = await find(threadId, id)
		const { checkpoint } = /** @type {any} */ (record.state)
		if (record.state.status === 'terminal' || record.abortRequested)
			throw Object.assign(new Error(`Scheduled task ${id} has ended`), {
				status: 409,
			})
		if (word.runner) {
			const to = current(record.input, checkpoint).to
			if (!to)
				throw new Error('Only a task that starts a new thread each run runs on a runner of its own')
			// Its model there, as the picker would move it: refused if that runner doesn't have it
			await core.address({ ...to, runner: word.runner })
		}
		if (word.run || word.runner || word.edit || Boolean(checkpoint?.paused) !== word.paused) {
			let sent = await core.signal(id, Control, `control-${checkpoint?.c ?? 0}`, word)
			// Its key expired as its time came: once that run sleeps again, on the next key
			for (let tries = 0; sent === 'closed' && tries < 100; tries++) {
				const now = await core.task(id)
				if (!now || now.state.status === 'terminal' || now.abortRequested) break
				const c = /** @type {any} */ (now.state).checkpoint?.c
				if (['sleeping', 'waiting'].includes(now.state.status) && c !== checkpoint?.c)
					sent = await core.signal(id, Control, `control-${c}`, word)
				else await new Promise((resolve) => setTimeout(resolve, 20))
			}
			if (sent === 'duplicate')
				throw Object.assign(new Error('It is taking another change; try again'), { status: 409 })
			if (sent !== 'delivered')
				throw Object.assign(new Error(`Scheduled task ${id} has ended`), {
					status: 409,
				})
		}
		return word.run
			? { ran: id }
			: word.edit
				? { edited: id }
				: word.runner
					? { moved: id, runner: word.runner }
					: word.paused
						? { paused: id }
						: { resumed: id }
	}

	/**
	 * Whom a run asks and how, worked out before its commit: the agent that set it, as itself; a bot, in her home; a
	 * new thread's agent; or, in its own thread, the recipients it carries (everyone there by default), resolved fresh
	 * each run, so the director never guesses for it
	 */
	async function recipients(threadId, input, signal) {
		if (input.conversation !== undefined) return {}
		if (input.to !== undefined) return { to: [await core.address(input.to, false, signal)] }
		if (input.bot !== undefined) {
			const name = (await core.homes())[threadId]
			return name ? { to: [await core.whom(threadId, name, false, signal)] } : null
		}
		const row = await core.thread(threadId)
		const names = input.recipients ?? Object.keys(row.agents ?? {})
		const to = (
			await Promise.all(
				names.map((name) => core.whom(threadId, name, false, signal).catch(() => null)),
			)
		).filter(Boolean)
		return { to }
	}

	/**
	 * The conversation a task's check runs in: the agent the run asks, its first recipient in a thread, or none for a
	 * task that starts a new thread each run
	 */
	async function checker(threadId, input) {
		if (input.conversation !== undefined) return input.conversation
		if (input.to !== undefined) return undefined
		const { agents = {} } = (await core.thread(threadId)) ?? {}
		const key = input.bot ?? (input.recipients ?? Object.keys(agents))[0]
		return agents[key]?.conversation
	}

	/** Posts one run's instructions: where it landed, `{thread, entry}`, or false when there's no one left to ask */
	async function run(tx, { id, threadId, input, asked, event, checked }) {
		const row = await core.threadIn(tx, threadId)
		if (row.hidden || !asked) return false
		const mark = {
			body: input.instructions,
			scheduledTask: id,
			...(event ? { event } : {}),
			...(checked ? { checked } : {}),
		}
		if (input.conversation !== undefined) {
			const key = Object.keys(row.agents).find(
				(key) => row.agents[key].conversation === input.conversation,
			)
			const to = key && (await core.agentOf(input.conversation, key, tx))
			if (!to) return false
			const { entry } = await core.post(
				tx,
				threadId,
				{ author: writtenTo(to), ...mark, to: [to] },
				{ member: true },
			)
			return { thread: threadId, entry }
		}
		if (input.to !== undefined) {
			const thread = await core.startThread(tx, defaultTitle(input.instructions), threadId)
			const { entry } = await core.post(
				tx,
				thread,
				{ author: input.by, ...mark, to: asked.to },
				{ empty: true },
			)
			return { thread, entry }
		}
		const { entry } = await core.post(
			tx,
			threadId,
			{
				author: input.by,
				...mark,
				...(asked.to.length ? { to: asked.to } : {}),
				...(asked.picked ? { picked: asked.picked } : {}),
			},
			{ direct: asked.direct, unlessPaused: asked.solo },
		)
		return { thread: threadId, entry }
	}

	const json = (value) => JSON.parse(JSON.stringify(value))
	const firstLine = (text) => String(text).split(/\r?\n/)[0].slice(0, 200)

	/**
	 * What a run of task `id` does once it knows what to: `end` it with a step in the trail; go on as `then` says with
	 * its runs (`next`: sleep on `{sleep}`, or `{end}` after a one-off); `onward`, unless that run was its last, its
	 * count used up or its next run past its end time; and `post` one run, with what its check found if it had one,
	 * ending the task if the check said `{done}`, or when there's no one left to ask
	 */
	const steps = ({ id, threadId, input, checkpoint }, rt, ctx) => {
		const { schedule } = input
		const end = async (tx, why, result = {}) => {
			await core.trailed(tx, threadId, undefined, 'ended', { task: id, why })
			return finished('completed', { ...result, ended: why })
		}
		const next = (then, runs) =>
			then.end ? finished('completed', { fired: true }) : asleep(schedule, { ...then.sleep, runs })
		const onward = async (tx, state, count) => {
			if (state.status === 'terminal') return state
			const why = endOf(schedule, count, state.checkpoint.paused ? undefined : state.checkpoint.at)
			if (why) return end(tx, why)
			return { ...state, checkpoint: { ...state.checkpoint, ran: count } }
		}
		const post = async (event, then, checked = undefined) => {
			const asked = await recipients(threadId, input, rt.signal).catch((error) => {
				rt.report(error)
				return null
			})
			return rt.commit(async (tx) => {
				const landed = await run(tx, { id, threadId, input, asked, event, checked })
				if (!landed) {
					await core.trailed(tx, threadId, undefined, 'skipped', {
						task: id,
						why: asked
							? 'its thread is archived or its agent gone; it ends'
							: 'it could not work out whom to ask; it ends',
					})
					return finished()
				}
				if (then.done) return end(tx, 'its check said done', { fired: true })
				const runs = [...(checkpoint.runs ?? []), { at: rt.now(), ...landed }].slice(-RUNS)
				return onward(tx, next(then, runs), (checkpoint.ran ?? 0) + 1)
			}, ctx)
		}
		return { end, next, onward, post }
	}

	/**
	 * Sleeps until its first run, then posts its instructions each time (run) and sleeps until the next, or ends after a
	 * one-off. A Control signal pauses it, sleeping on its next key only, or resumes it from now. One `on` events sleeps
	 * on Hooked `event-N`, posts the event beside its instructions, and sleeps on `event-N+1`.
	 */
	const ScheduledTask = defineTask({
		name: 'ade.scheduled-task',
		version: 1,
		initial: () => ({ phase: 'sleep' }),
		phases: {
			sleep: ({ input }, rt, ctx) =>
				rt.commit(
					() =>
						asleep(input.schedule, {
							phase: 'fire',
							c: 0,
							n: 0,
							at: firstRun(input.schedule, rt.now()),
							runs: input.runs ?? [],
						}),
					ctx,
				),
			fire: async ({ id, conversationId: threadId, input: set, state }, rt, ctx) => {
				const checkpoint = { .../** @type {any} */ (state).checkpoint }
				const input = current(set, checkpoint)
				const { schedule } = input
				const runs = checkpoint.runs ?? []
				const ran = (run) => [...runs, run].slice(-RUNS)
				const { end, onward, post, next } = steps({ id, threadId, input, checkpoint }, rt, ctx)
				/** One run, going on as `then` says after it; with a check, it waits on that first, and its phase decides */
				const due = async (heard, then) => {
					const event = heard && 'value' in heard ? json(heard.value) : undefined
					if (!(input.check && checking)) return post(event, then)
					const conversation = await checker(threadId, input)
					const after = { ...(then.sleep ?? checkpoint), phase: 'checked', then }
					if (conversation === undefined)
						return rt.commit(
							() => ({
								status: 'running',
								checkpoint: { ...after, said: { failed: 'it has no agent to check as' } },
							}),
							ctx,
						)
					return rt.commit(async (tx) => {
						const task = await tx.createTask(
							CheckRun,
							{
								code: input.check,
								input: {
									state: checkpoint.state ?? null,
									runs: checkpoint.checks ?? 0,
									now: rt.now(),
									...(event ? { event } : {}),
								},
							},
							background(conversation),
						)
						return {
							status: 'waiting',
							on: [task],
							policy: 'allSettled',
							checkpoint: { ...after, checking: task, ...(event ? { event } : {}) },
						}
					}, ctx)
				}
				const told = await rt.readSignal(Control, `control-${checkpoint.c}`, ctx)
				// Woken by its time, its Control key expired; the next sleep takes a fresh one
				if (told && 'expired' in told) checkpoint.c += 1
				if (told && 'value' in told) {
					const word = /** @type {any} */ (json(told.value))
					const moved = { ...checkpoint, c: checkpoint.c + 1 }
					// Run now runs once and keeps its schedule
					if (word.run) return due(undefined, { sleep: moved })
					// Its runs ask another runner from now on, its model there
					if (word.runner)
						return rt.commit(
							() =>
								asleep(schedule, {
									...moved,
									to: { ...input.to, runner: word.runner },
								}),
							ctx,
						)
					// Edited, it does what it says now; a new schedule starts its wait, and its count, over from now
					if (word.edit) {
						const edited = { ...moved, ...word.edit }
						if (word.edit.schedule)
							Object.assign(edited, {
								at: firstRun(word.edit.schedule, rt.now()),
								since: rt.now(),
								ran: 0,
							})
						return rt.commit(() => asleep(edited.schedule ?? schedule, edited), ctx)
					}
					const after = {
						...moved,
						paused: word.paused,
						note: word.paused ? word.note : undefined,
						...(word.paused ? {} : { strikes: 0 }),
					}
					// Resumed, a one-off overdue runs now; a repeating one at its next run from now
					if (!word.paused && checkpoint.at !== undefined)
						after.at =
							checkpoint.at > rt.now()
								? checkpoint.at
								: (following(schedule, checkpoint.at, rt.now()) ?? rt.now())
					return rt.commit(() => asleep(schedule, after), ctx)
				}
				// Woken by its end time, paused, listening, or with its next run past it, it ends without a run
				if (
					schedule.until !== undefined &&
					(checkpoint.paused || checkpoint.at === undefined
						? rt.now() >= schedule.until
						: checkpoint.at > schedule.until)
				)
					return rt.commit((tx) => end(tx, 'its end time passed'), ctx)
				if (checkpoint.paused) return rt.commit(() => asleep(schedule, checkpoint), ctx)
				if (schedule.on !== undefined) {
					const heard = await rt.readSignal(Hooked, `event-${checkpoint.n}`, ctx)
					if (!(heard && 'value' in heard))
						return rt.commit(() => asleep(schedule, checkpoint), ctx)
					return due(heard, { sleep: { ...checkpoint, n: checkpoint.n + 1 } })
				}
				const at =
					checkpoint.at === undefined ? undefined : following(schedule, checkpoint.at, rt.now())
				const then = at === undefined ? { end: true } : { sleep: { ...checkpoint, at } }
				// Its last run's thread still working, a timed run is skipped, as Temporal's default overlap does
				const last = runs.findLast((run) => run.thread !== undefined)
				if (checkpoint.at !== undefined && last !== undefined)
					if (await core.busy(last.thread)) {
						const offline = await core.waitingFor(last.thread)
						const skipped = offline.length
							? `${offline.join(' and ')} offline`
							: 'the run before still working'
						return rt.commit(async (tx) => {
							await core.trailed(tx, threadId, undefined, 'skipped', {
								task: id,
								why: skipped,
							})
							return onward(tx, next(then, ran({ at: rt.now(), skipped })), checkpoint.ran ?? 0)
						}, ctx)
					}
				return due(undefined, then)
			},
			/**
			 * Its check ended. A post runs it as any run does, with what the check found beside it; quiet or failed, the run
			 * is kept among its runs and in the trail. STRIKES failures in a row pause it; done ends it after this run.
			 */
			checked: async ({ id, conversationId: threadId, input: set, state }, rt, ctx) => {
				const {
					checking,
					then,
					event,
					said: given,
					...rest
				} = /** @type {any} */ (state).checkpoint
				const checkpoint = { ...rest, phase: 'fire' }
				const input = current(set, checkpoint)
				const { end, onward, post, next } = steps({ id, threadId, input, checkpoint }, rt, ctx)
				const said = given ?? outcomeOf(await rt.getTask(checking, ctx))
				const at = rt.now()
				const runs = checkpoint.runs ?? []
				const count = (checkpoint.ran ?? 0) + 1
				const kept = {
					...(said.state !== undefined ? { state: said.state } : {}),
					checks: (checkpoint.checks ?? 0) + 1,
					strikes: 0,
				}
				const going = then.end ? then : { sleep: { ...then.sleep, ...kept } }
				if (said.failed) {
					const strikes = (checkpoint.strikes ?? 0) + 1
					const failed = [...runs, { at, failed: said.failed, output: said.output ?? '' }].slice(
						-RUNS,
					)
					const paused = !then.end && strikes >= STRIKES
					const after = then.end
						? then
						: {
								sleep: {
									...then.sleep,
									strikes,
									...(paused
										? {
												paused: true,
												note: `its check failed ${STRIKES} times: ${said.failed}`.slice(0, 200),
											}
										: {}),
								},
							}
					return rt.commit(async (tx) => {
						await core.trailed(tx, threadId, undefined, 'checked', {
							task: id,
							failed: said.failed,
						})
						return onward(tx, next(after, failed), count)
					}, ctx)
				}
				if (said.post) return post(event, said.done ? { done: true } : going, said.post)
				const last = runs.at(-1)
				const quiet =
					last?.checked !== undefined
						? [...runs.slice(0, -1), { at, checked: last.checked + 1, output: said.output ?? '' }]
						: [...runs, { at, checked: 1, output: said.output ?? '' }].slice(-RUNS)
				return rt.commit(async (tx) => {
					await core.trailed(tx, threadId, undefined, 'checked', {
						task: id,
						...(said.output ? { said: firstLine(said.output) } : {}),
					})
					if (said.done) return end(tx, 'its check said done')
					return onward(tx, next(going, quiet), count)
				}, ctx)
			},
		},
		abort: (_task, rt, ctx) => rt.commit(() => finished('aborted'), ctx),
	})

	/** Makes one in `threadId` and says so; hooks give an event's task its secret in the same commit */
	async function make(requestKey, threadId, input) {
		const id = await core.once(requestKey, 'schedule', async (tx) => {
			const made = await tx.createTask(ScheduledTask, input, background(threadId))
			if (input.schedule.on !== undefined) await issue(tx, made)
			return made
		})
		settleNew(input.schedule)
		return id
	}

	/** How an agent's task runs, in words */
	const when = (schedule) =>
		(schedule.on !== undefined
			? `on ${EVENTS[schedule.on]}`
			: schedule.after !== undefined
				? `after thread ${schedule.after}`
				: schedule.when !== undefined
					? happening(schedule.when)
					: schedule.times
						? `${schedule.days ? schedule.days.map((day) => DAYS[day]).join(', ') : 'daily'} at ${schedule.times.join(' and ')} ${schedule.timeZone}`
						: schedule.every
							? `every ${span(schedule.every)} from ${new Date(schedule.at).toISOString()}`
							: `at ${new Date(schedule.at).toISOString()}`) +
		(schedule.until === undefined ? '' : ` until ${new Date(schedule.until).toISOString()}`) +
		(schedule.count === undefined
			? ''
			: `, ${schedule.count} run${schedule.count === 1 ? '' : 's'}`)

	const schedule = defineTool({
		name: 'schedule',
		description: `Come back to this thread later: your instructions arrive here as a message to you after \`in\` or \`at\` a date and time, every \`every\` (from \`at\` if given), at clock \`times\` on \`days\` (${ZONE}), once thread \`after\` has finished its work, or \`when\` something happens in ade${hooks ? ', or on each outside event `on` names until you cancel it' : ''}. One that repeats can stop by itself, \`until\` a time or after \`count\` runs. Returns at once. Or cancel one by its id.`,
		parameters: obj({
			instructions: opt(
				str({
					description: "What to do when it runs, written so you'll know without context",
				}),
			),
			in: opt(str({ description: 'How long until it runs once: 90s, 5m, 1h30m, 2d' })),
			at: opt(
				str({
					description: `A date and time, like 2026-11-24T09:00 on the clock in ${ZONE}: once then, or with every its first run`,
				}),
			),
			every: opt(
				str({
					description:
						'Run again this often, at least 1m; first after `in`, at `at`, or after one `every`',
				}),
			),
			times: opt(
				arr(str(), {
					description: `Clock times in ${ZONE}, like ["09:00", "17:30"]; it keeps to the clock across its changes`,
				}),
			),
			days: opt(
				arr(str(), {
					description: 'With times: the weekdays, mon … sun; every day if left out',
				}),
			),
			after: opt(
				num({
					description:
						"Another thread's id: run once its work ends (now, if it's idle), instead of at a time",
				}),
			),
			when: opt(
				obj(
					{
						online: opt(str({ description: 'A runner, when it comes online' })),
						offline: opt(str({ description: 'A runner, when it goes offline' })),
						failed: opt(num({ description: 'A thread, when a run there fails' })),
						answered: opt(num({ description: 'A thread, when an agent there answers' })),
					},
					{
						description:
							'Run once when one thing happens in ade, instead of at a time: {online: "vps"} when runner vps comes online, {offline: "vps"}, {failed: 12} when a run in thread 12 fails, {answered: 12} when an agent there answers. A runner already online, or offline, runs it at once.',
					},
				),
			),
			until: opt(
				str({
					description: `With every, times or on: stop after this, a date and time like 2026-11-24T18:00 (${ZONE}) or a duration from now like 2h`,
				}),
			),
			count: opt(
				num({
					description: 'With every, times or on: stop after this many runs',
				}),
			),
			...(hooks
				? {
						on: opt(
							str({
								description:
									"Run on an outside event instead: 'push' or 'ci' (a failed run) from a GitHub webhook, 'hook' from any service's POST. You get its typed facts (repo, branch, commits; workflow path, conclusion; event name, size). Only the owner sees its secret.",
							}),
						),
					}
				: {}),
			...(checking
				? {
						check: opt(
							str({
								description:
									'A Code Mode script that runs before each run, as you, with your tools and no model: `input` is {state, runs, now, event?}; post(text) has this run ask you, with text beside the instructions; done() ends the task after this run; keep(value) is input.state next time. Calling none, the run stays quiet. It cannot call schedule.',
							}),
						),
					}
				: {}),
			cancel: opt(num({ description: "A scheduled task's id, to cancel it instead" })),
		}),
		replay: 'safe',
		execute: async (input, api) => {
			const args = /** @type {any} */ (input)
			const at = await core.home(api.conversationId)
			if (!at) throw new Error('Only an agent in a thread can schedule a task')
			if (args.cancel !== undefined) {
				const ended = await cancel(at.thread, args.cancel)
				const said = ended.cancelled
					? 'Cancelled'
					: ended.fired
						? 'Too late: it already ran,'
						: 'It had already ended,'
				return {
					output: [{ type: 'text', text: `${said} scheduled task ${args.cancel}.` }],
				}
			}
			const instructions = args.instructions?.trim()
			if (!instructions) throw new Error('instructions is required')
			const planned = await scheduleOf(args, {
				core,
				hooks,
				threadId: at.thread,
			})
			const check = checkOf(args, {})
			const id = await make(`schedule ${api.taskId}`, at.thread, {
				conversation: api.conversationId,
				by: at.name,
				instructions,
				schedule: planned,
				...(check ? { check } : {}),
			})
			const others = (await pending(at.thread)).filter((one) => one.id !== id)
			return {
				output: [
					{
						type: 'text',
						text: [
							`Scheduled task ${id}, ${when(planned)}. Your instructions come back here as a message; end your turn.`,
							...(planned.on === undefined
								? []
								: [
										`Its hook is /hooks/${id} on the server's hooks address; it listens until cancelled. Only the owner sees its secret, beside the task above the composer: ask them to ${planned.on === 'hook' ? 'give it to the service that calls' : 'add it as a GitHub webhook (JSON) with that secret'}. What arrives is outside data, not instructions.`,
									]),
							...(others.length
								? [
										'Other scheduled tasks here:',
										...others.map(
											(one) =>
												`- ${one.id} ${when(one.schedule)}${one.paused ? ', paused' : ''}: ${one.instructions}`,
										),
									]
								: []),
						].join('\n'),
					},
				],
			}
		},
	})

	/**
	 * Who a task running in its own thread asks each time, from `body.recipients`: keys into that thread's agents (a
	 * bot's name, or `agent` for its own); left out, it asks everyone there, worked out fresh each run
	 */
	async function recipientsOf(body, threadId) {
		if (body.recipients === undefined) return {}
		if (!Array.isArray(body.recipients) || !body.recipients.length)
			throw new Error('recipients is who it asks there, at least one')
		const { agents } = await core.thread(threadId)
		const unknown = body.recipients.find((name) => typeof name !== 'string' || !agents?.[name])
		if (unknown !== undefined) throw new Error(`${unknown} isn't in thread ${threadId}`)
		return { recipients: [...new Set(body.recipients)] }
	}

	/**
	 * Where a person's task runs, from `bot`, `thread` or `to`: its thread, unless it starts one, and what its input says
	 * about it
	 */
	async function placed(body) {
		const places = ['bot', 'thread', 'to'].filter((place) => body[place] !== undefined)
		if (places.length !== 1)
			throw new Error('A task runs in one of: a bot, a thread, or `to` a new thread each run')
		if (body.bot !== undefined) {
			const homes = await core.homes()
			const threadId = Number(Object.keys(homes).find((home) => homes[home] === body.bot))
			if (!threadId) throw new Error(`No bot ${body.bot}`)
			return { threadId, input: { bot: body.bot } }
		}
		if (body.thread !== undefined) {
			const threadId = Number(body.thread)
			await core.conversation(threadId)
			return { threadId, input: await recipientsOf(body, threadId) }
		}
		return { threadId: undefined, input: { to: await core.address(body.to) } }
	}

	/** Makes a task where `where` says, starting a thread for one that starts a new one each run */
	async function makeIn(where, input, key) {
		const threadId =
			where.threadId ??
			(await core.commit((tx) =>
				core.startThread(tx, `Scheduled: ${defaultTitle(input.instructions)}`, null),
			))
		const id = await make(key, threadId, { ...input, ...where.input })
		return { id, thread: threadId }
	}

	/** Instructions from a request, trimmed; required */
	/**
	 * A check from a request, trimmed: `''` removes one on an edit; refused without check on, too long, or for a task that
	 * starts a new thread each run, which has no agent to check as
	 */
	const checkOf = (body, place) => {
		if (body.check === undefined) return undefined
		if (!checking)
			throw new Error('A check needs the check module, which MODULES=-check turned off')
		if (typeof body.check !== 'string') throw new Error('check is the text of a script')
		const check = body.check.trim()
		if (check.length > MOST) throw new Error(`A check is at most ${MOST} characters`)
		if (check && place.to !== undefined)
			throw new Error(
				"A task that starts a new thread each run has no agent to check as; it can't have a check",
			)
		return check
	}

	const instructionsOf = (body) => {
		const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : ''
		if (!instructions) throw new Error('instructions is required')
		return instructions
	}

	/**
	 * A person's new task: `{instructions, bot | thread | to, in | at | every | times | after | on, …, key?}`. `to`, a
	 * model at a runner, runs each time in a new thread under one made for the task.
	 */
	async function create(body, user) {
		const instructions = instructionsOf(body)
		const where = await placed(body)
		const schedule = await scheduleOf(body, {
			core,
			hooks,
			threadId: where.threadId,
		})
		const key = typeof body.key === 'string' && body.key ? body.key.slice(0, 100) : undefined
		const check = checkOf(body, where.input)
		return makeIn(
			where,
			{ by: user, instructions, schedule, ...(check ? { check } : {}) },
			key && `schedule ${user}/${key}`,
		)
	}

	/**
	 * Changes a task's instructions, when it runs or where, keeping its runs: `{edited}`. In place, unless it moves to
	 * another thread or starts or stops listening for events: then a new task takes its place, `{edited, id, thread}`.
	 */
	async function edit(threadId, id, body, user) {
		const record = await find(threadId, id)
		const { checkpoint } = /** @type {any} */ (record.state)
		if (record.state.status === 'terminal' || record.abortRequested)
			throw Object.assign(new Error(`Scheduled task ${id} has ended`), {
				status: 409,
			})
		const was = current(record.input, checkpoint)
		const instructions = body.instructions === undefined ? undefined : instructionsOf(body)
		const schedule = WHEN.some((name) => body[name] !== undefined)
			? await scheduleOf(body, { core, hooks, threadId: record.conversationId })
			: undefined
		const places = ['bot', 'thread', 'to'].filter((place) => body[place] !== undefined)
		if (places.length && was.conversation !== undefined)
			throw new Error("An agent's task runs in its own thread")
		const staying =
			!places.length ||
			(body.bot !== undefined && body.bot === was.bot) ||
			(body.to !== undefined && was.to !== undefined) ||
			(body.thread !== undefined &&
				was.bot === undefined &&
				was.to === undefined &&
				Number(body.thread) === record.conversationId)
		const listens = (schedule ?? was.schedule).on !== undefined
		if (staying && listens === (was.schedule.on !== undefined)) {
			const to =
				body.to !== undefined && was.to !== undefined ? await core.address(body.to) : undefined
			const recipients =
				was.bot === undefined && was.to === undefined && was.conversation === undefined
					? (await recipientsOf(body, record.conversationId)).recipients
					: undefined
			const check = checkOf(body, was)
			const edited = await control(threadId, id, {
				edit: {
					...(instructions ? { instructions } : {}),
					...(check !== undefined ? { check } : {}),
					...(schedule ? { schedule } : {}),
					...(to ? { to } : {}),
					...(recipients ? { recipients } : {}),
				},
			})
			if (schedule) settleNew(schedule)
			return edited
		}
		const where = places.length
			? await placed(body)
			: {
					threadId: record.conversationId,
					input: was.bot
						? { bot: was.bot }
						: was.to
							? { to: was.to }
							: await recipientsOf(body, record.conversationId),
				}
		const check = checkOf(body, where.input) ?? was.check
		const made = await makeIn(where, {
			by: was.by,
			...(was.conversation === undefined ? {} : { conversation: was.conversation }),
			instructions: instructions ?? was.instructions,
			schedule: schedule ?? was.schedule,
			...(check ? { check } : {}),
			runs: checkpoint?.runs ?? [],
		})
		await cancel(undefined, id)
		return { edited: id, ...made }
	}

	/**
	 * A thread's tasks, or without one every task in the house. POST `{cancel}`, `{pause, note?}`, `{resume}`, `{run}` or
	 * `{edit, …}` takes a task's id; a POST with `instructions` and no id makes one (create).
	 */
	async function serve(threadId, _query, body, user) {
		if (threadId !== undefined) await core.conversation(threadId)
		if (body === undefined) return pending(threadId)
		if (body.edit !== undefined) {
			if (!Number.isInteger(body.edit)) throw new Error("edit is the task's id")
			return edit(threadId, body.edit, body, user)
		}
		if (body.instructions !== undefined) {
			if (threadId !== undefined) body = { ...body, thread: threadId }
			return create(body, user)
		}
		for (const action of ['cancel', 'pause', 'resume', 'run', 'move'])
			if (body[action] !== undefined) {
				if (!Number.isInteger(body[action])) throw new Error(`${action} is the task's id`)
				if (action === 'cancel') return cancel(threadId, body.cancel)
				if (action === 'run') return control(threadId, body.run, { run: true })
				if (action === 'move') {
					if (typeof body.runner !== 'string' || !body.runner)
						throw new Error('move takes the runner its runs ask from now on')
					return control(threadId, body.move, { runner: body.runner })
				}
				const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : ''
				return control(threadId, body[action], {
					paused: action === 'pause',
					...(action === 'pause' && note ? { note } : {}),
				})
			}
		throw new Error(
			'POST cancel, pause, resume, run or edit with a task id, move with one and a runner, or instructions for a new task',
		)
	}

	/**
	 * Archiving a thread ends its tasks: one due meanwhile finds the thread hidden in its own commit and posts nothing,
	 * and once the archive is stored every task still live is aborted
	 */
	async function archiving(tx, threadId) {
		core.afterCommit(tx, () =>
			core
				.tasks({
					conversationId: threadId,
					kind: ScheduledTask.definition.name,
				})
				.then((tasks) =>
					Promise.all(
						tasks
							.filter((one) => one.state.status !== 'terminal')
							.map((one) => core.abortTask(one.id)),
					),
				)
				.catch((error) => console.error(error)),
		)
	}

	core.feed.define('schedule', {
		keyOf: (task) => task.id,
		all: () => pending(undefined),
		match: (change) => {
			if (change.type === 'task') return change.value.kind === ScheduledTask.definition.name
			if (change.type === 'document') return change.record.kind === 'ade.thread'
			return false
		},
	})
	core.feed.define('schedule/', {
		keyOf: (task) => task.id,
		all: (_viewer, param) => pending(Number(param)),
		match: (change, param) =>
			change.type === 'task' &&
			change.value.kind === ScheduledTask.definition.name &&
			change.value.conversationId === Number(param),
	})

	return {
		serve,
		archiving,
		start: () => (settling(), waking(already)),
		ended: settling,
		/** A runner came online or went offline */
		runner: (name, online) => waking((when) => when[online ? 'online' : 'offline'] === name),
		/** A run in a thread failed, or an agent there answered, as its trail says */
		entryStored: (entry) => {
			const step = entry.kind === 'ade.trail' ? entry.data : undefined
			if (step?.kind === 'failed' || step?.kind === 'answered')
				waking((when) => when[step.kind] === step.thread)
		},
		extension: defineExtension({
			name: 'ade.schedule',
			tools: [schedule],
			tasks: [ScheduledTask],
			sections: [
				{
					key: 'schedule',
					tag: false,
					render: () =>
						'To check back later (CI, a deploy, a daily routine), schedule a task instead of waiting; a message marked scheduled-task is your own instructions coming back.',
				},
			],
		}),
	}
}
