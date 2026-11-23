/**
 * Scheduled tasks: instructions that arrive in a thread later. A thread's above its composer, each with a ring that fills
 * as its next run nears, pause and ×; every task in the house from the list's foot, with a form for a new one; the row a
 * schedule call leaves in the chat, and a run's own line.
 */
import html from '@solidjs/html'
import { createEffect, createSignal, createUniqueId, For, Show } from 'solid-js'
import { Icon } from './icons.js'
import {
	api,
	bots,
	feedView,
	homeBot,
	hrefOf,
	openThread,
	runners,
	server,
	threadOf,
	threadRows,
	titleOf,
} from './server.js'
import { placePopover } from './popover.js'
import { Panes } from './panes.js'
import { shortLabel, thinkingWord } from './agent.js'
import { ModelPicker } from './model-picker.js'
import { PlainStep } from './run.js'
import { ahead } from './time.js'
import { report } from './notice.js'
import { showMessage } from './search.js'
import { runnersWith } from './runner.js'
import { DAYS as DAY_KEYS, runsAfter, span } from './clock.js'

/** What a task can run `on`, as the server's hooks.js says it */
const EVENTS = {
	push: 'each GitHub push',
	ci: 'each failed GitHub CI run',
	hook: 'each call to its hook',
}
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** A clock for the countdowns and rings, a second at a time */
const [now, setNow] = createSignal(Date.now())
setInterval(() => setNow(Date.now()), 1000)

/** in 42s in its last minute, in 8m within the hour, in 17h within two days, then as other times ahead read */
const countdown = (at) => {
	const left = at - now()
	if (left <= 0) return 'now'
	if (left < 60_000) return `in ${Math.ceil(left / 1000)}s`
	if (left < 3_600_000) return `in ${Math.ceil(left / 60_000)}m`
	if (left < 48 * 3_600_000) return `in ${Math.round(left / 3_600_000)}h`
	return ahead(at)
}

/** 09:00, 12:00 and 17:30 */
const listed = (words) =>
	words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '')

/** Which days a clock schedule runs on: daily, weekdays, weekends, Mondays, or Mon, Wed and Fri */
const daysOf = (days) => {
	if (!days || days.length === 7) return 'daily'
	const key = days.join('')
	if (key === '12345') return 'weekdays'
	if (key === '06') return 'weekends'
	if (days.length === 1) return DAYS[days[0]]
	return listed(days.map((day) => DAYS[day].slice(0, 3)))
}

/** What a task `when` waits for, as the server's schedule.js says it: a runner by name, a thread by id */
const HAPPENINGS = {
	online: {
		runner: true,
		said: (name) => `when ${name} comes online`,
		label: 'When a runner comes online',
	},
	offline: {
		runner: true,
		said: (name) => `when ${name} goes offline`,
		label: 'When a runner goes offline',
	},
	failed: {
		said: (id) => `when ${titleOf(id)} fails`,
		label: 'When a thread fails',
	},
	answered: {
		said: (id) => `when ${titleOf(id)} answers`,
		label: 'When a thread answers',
	},
}
/** when vps comes online, when Deploy fails */
const happening = (when) => {
	const [name] = Object.keys(when)
	return HAPPENINGS[name]?.said(when[name]) ?? name
}

/** How it ends, if it does: until 18:00, 3 runs */
const endOf = (schedule) =>
	[
		schedule.until === undefined ? '' : `until ${runLabel(schedule.until, schedule.timeZone)}`,
		schedule.count === undefined ? '' : `${schedule.count} run${schedule.count === 1 ? '' : 's'}`,
	]
		.filter(Boolean)
		.join(', ')

/** How a schedule repeats, or what it waits for, and when it ends */
const repeatOf = (schedule) => [startOf(schedule), endOf(schedule)].filter(Boolean).join(', ')
const startOf = (schedule) => {
	if (schedule.on !== undefined) return `on ${EVENTS[schedule.on]}`
	if (schedule.after !== undefined) return `once ${titleOf(schedule.after)} is done`
	if (schedule.when !== undefined) return happening(schedule.when)
	if (schedule.every) return `every ${span(schedule.every)}`
	if (!schedule.times) return 'once'
	const zone = schedule.timeZone === HERE ? '' : ` ${schedule.timeZone}`
	return `${daysOf(schedule.days)} at ${listed(schedule.times)}${zone}`
}

/** How it reads in a line: a one-off by when it comes, anything else by how it repeats; and whether a check runs first */
const shortWhen = (task) =>
	`${
		task.paused
			? `paused, ${repeatOf(task.schedule)}`
			: task.schedule.times || task.schedule.every || task.at === undefined
				? repeatOf(task.schedule)
				: countdown(task.at)
	}${task.check ? ', checks first' : ''}`

/** When it runs next and how it repeats: in 8m, daily at 09:00; paused, why, then how it repeats */
const whenOf = (task) =>
	task.paused
		? `paused${task.note ? ` (${task.note})` : ''}, ${repeatOf(task.schedule)}`
		: [
				task.at === undefined ? '' : countdown(task.at),
				repeatOf(task.schedule),
				task.check ? 'checks first' : '',
			]
				.filter(Boolean)
				.join(', ')

/** Where a task runs, in a word: a bot, a new thread each run, or its thread */
const placeOf = (task) =>
	task.bot ??
	(task.to
		? `new thread each run, ${task.to.model?.split('/').pop() ?? task.to.runner}`
		: titleOf(task.thread))

/**
 * How far along the wait for its next run is, as a ring in the text's ink: full at its time, until the run lands and
 * a new wait starts it over. A task with no time to wait for shows it empty.
 */
function Ring(props) {
	const R = 8
	const LENGTH = 2 * Math.PI * R
	const part = () => {
		const { at, from } = props.task
		if (at === undefined || from === undefined || at <= from) return 0
		return Math.min(1, Math.max(0, (now() - from) / (at - from)))
	}
	return html`
		<svg class="icon ring" viewBox="0 0 24 24" aria-hidden="true">
			<circle cx="12" cy="12" r=${R} class="track" />
			<circle
				cx="12"
				cy="12"
				r=${R}
				class="done"
				stroke-dasharray=${LENGTH}
				stroke-dashoffset=${() => LENGTH * (1 - part())}
			/>
		</svg>
	`
}

const taskSort = (left, right) =>
	(left.at ?? Infinity) - (right.at ?? Infinity) || (left.id ?? 0) - (right.id ?? 0)

/** When a past run was: 08:00 today, else its weekday too */
const whenWas = (at) => {
	const date = new Date(at)
	const clock = date.toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	})
	return date.toDateString() === new Date().toDateString()
		? clock
		: `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${clock}`
}

/**
 * A task that starts a new thread on a runner that's offline: a button for every online runner that has its model,
 * which its runs ask from now on
 */
function OfflineRunner(props) {
	const to = () => props.task.to
	const offline = () => to() && !runners.find((runner) => runner.name === to().runner)?.online
	return html`
		<${Show} when=${offline}>
			<small>
				${() =>
					`${to().runner} is offline.${runnersWith(to().model).length ? ' Run on' : ' No runner online has its model.'}`}
				<${For} each=${() => runnersWith(to().model)}
					>${(runner) => html`
						<button
							type="button"
							class="ghost small"
							title=${() => `Its runs start on ${runner.name} from now on, in ${runner.dir}`}
							onClick=${(event) => {
								event.stopPropagation()
								api('/api/schedule', {
									move: props.task.id,
									runner: runner.name,
								}).catch(report)
							}}
						>
							${() => runner.name}
						</button>
					`}<//
				>
			</small>
		<//>
	`
}

/** A run that asked no one, in words: skipped and why, its check quiet, or its check failed and why; else nothing */
const unasked = (run) =>
	run.skipped
		? `skipped at ${whenWas(run.at)}: ${run.skipped}`
		: run.checked
			? `checked at ${whenWas(run.at)}, quiet${run.checked > 1 ? ` ${run.checked} times running` : ''}`
			: run.failed
				? `check failed at ${whenWas(run.at)}: ${run.failed}`
				: ''

/** Its last run: when, opening the message it posted; or that it asked no one, and why */
function LastRun(props) {
	const last = () => props.task.runs?.at(-1)
	return html`
		<${Show} when=${last}>
			<small>
				<${Show}
					when=${() => !unasked(last())}
					fallback=${html`${() => `Last run ${unasked(last())}`}`}
				>
					<a
						class="thread-link"
						href=${() => hrefOf(last().thread)}
						onClick=${(event) => {
							event.preventDefault()
							event.stopPropagation()
							props.onOpen?.()
							showMessage(last().thread, last().entry)
						}}
						>${() => `Last run ${whenWas(last().at)}`}</a
					>
				<//>
			</small>
		<//>
	`
}

/**
 * Run now, pause or resume, and ×. Pause asks why first, in a line you can leave empty; the strip and list fetch again
 * on the change.
 */
function Controls(props) {
	const [asking, setAsking] = createSignal(false)
	const act = (body) => api(props.path, body).catch(report)
	const stop = (event) => event.stopPropagation()
	const pause = (note) => {
		setAsking(false)
		act({
			pause: props.task.id,
			...(note.trim() ? { note: note.trim() } : {}),
		})
	}
	return html`
		<${Show}
			when=${asking}
			fallback=${html`
				<button
					type="button"
					class="ghost small"
					title="Run it once now, outside its schedule"
					onClick=${(event) => {
						stop(event)
						act({ run: props.task.id })
					}}
				>
					run now
				</button>
				<button
					type="button"
					class="ghost small"
					aria-label=${() => (props.task.paused ? 'Resume this task' : 'Pause this task')}
					title=${() => (props.task.paused ? 'Resume this task' : 'Pause this task')}
					onClick=${(event) => {
						stop(event)
						if (props.task.paused) act({ resume: props.task.id })
						else setAsking(true)
					}}
				>
					${() => (props.task.paused ? 'resume' : 'pause')}
				</button>
				<button
					type="button"
					class="ghost small"
					aria-label="Cancel this task"
					title="Cancel this task"
					onClick=${(event) => {
						stop(event)
						act({ cancel: props.task.id })
					}}
				>
					<${Icon} name="close" />
				</button>
			`}
		>
			<form
				class="pause-note"
				onClick=${stop}
				onKeyDown=${(event) => {
					stop(event)
					if (event.key === 'Escape') setAsking(false)
				}}
				onSubmit=${(event) => {
					event.preventDefault()
					pause(new FormData(event.currentTarget).get('note')?.toString() ?? '')
				}}
			>
				<input
					name="note"
					aria-label="Why pause it"
					placeholder="Why? (optional)"
					ref=${(el) => queueMicrotask(() => el.focus())}
				/>
				<button type="submit" class="ghost small">pause</button>
			</form>
		<//>
	`
}

/**
 * A task as a row: where it runs if asked, when next, its last run, its instructions, and its controls on a line of
 * their own. With `onGo` the row opens its form.
 */
function TaskRow(props) {
	return html`
		<li
			role=${() => (props.onGo ? 'button' : undefined)}
			tabindex=${() => (props.onGo ? '0' : undefined)}
			class=${() => ({ paused: props.task.paused })}
			onClick=${(event) => props.onGo?.(event)}
			onKeyDown=${(event) =>
				event.key === 'Enter' && event.target === event.currentTarget && props.onGo?.(event)}
		>
			<${Show} when=${() => props.task.from ?? `none ${props.task.paused}`} keyed
				>${() => html`<${Ring} task=${() => props.task} />`}<//
			>
			<div>
				<${Show} when=${() => props.place}><span>${() => placeOf(props.task)}</span><//>
				<small
					>${() =>
						props.task.paused
							? `P${whenOf(props.task).slice(1)}`
							: `Next ${whenOf(props.task)}`}</small
				>
				<${LastRun} task=${() => props.task} onOpen=${() => props.onOpen?.()} />
				<${OfflineRunner} task=${() => props.task} />
				<small class="said"
					>${() => `${shortLabel(props.task.by)}: ${props.task.instructions}`}</small
				>
			</div>
			<div class="controls">
				<${Controls} task=${() => props.task} path=${() => props.path} />
			</div>
		</li>
	`
}

/** A thread's tasks as rows in its details, then a + that opens the form for it */
export function ThreadTasks(props) {
	const tasks = feedView(() => (props.thread ? `schedule/${props.thread}` : null), {
		sort: taskSort,
	})
	return html`
		<ul class="rows tasks">
			<${For} each=${tasks} keyed=${(task) => task.id}
				>${(task) =>
					html`<${TaskRow}
						task=${() => task()}
						path=${() => `/api/threads/${props.thread}/schedule`}
						onGo=${(_e) => openTaskForm(props.thread, task())}
					/>`}<//
			>
		</ul>
		<ul class="thread-family">
			<li class="new">
				<button
					type="button"
					class="row"
					title="Instructions that arrive here later, once or on a schedule"
					onClick=${(_event) => openTaskForm(props.thread)}
				>
					<span class="plus" aria-hidden="true"><${Icon} name="plus" /></span>
					<span>New task</span>
				</button>
			</li>
		</ul>
	`
}

/** Asked to open the form from somewhere else, as `{thread}`: the list opens on it */
const [asked, setAsked] = createSignal(null)
/** Opens the New task form, for `thread` if given, else for the bot last used; given a task, its own form to edit */
export const openTaskForm = (thread, task = undefined) => setAsked({ thread, task })

/**
 * Every task in the house, in a popover from the list's foot: where it runs, when, its instructions, pause and ×; New
 * task opens the form over it. Fetched when it opens and, while open, on each change.
 */
export function ScheduledTaskList() {
	let button, panel
	const id = createUniqueId()
	const [open, setOpen] = createSignal(false)
	const [form, setForm] = createSignal(null)
	const tasks = feedView(() => (open() ? 'schedule' : null), {
		sort: taskSort,
	})
	const openForm = (thread, task) => {
		setForm({ thread, task })
		if (!panel.matches(':popover-open')) panel.showPopover()
	}
	// The form is taller than the list it covers: place the popover again once either shows
	createEffect(form, () => {
		if (panel?.matches(':popover-open')) setTimeout(() => placePopover(panel, button))
	})
	createEffect(tasks, () => {
		if (panel?.matches(':popover-open')) setTimeout(() => placePopover(panel, button))
	})
	// The thread's details or the jump list ask for the form
	createEffect(asked, (wish) => {
		if (!wish) return
		setAsked(null)
		openForm(wish.thread, wish.task)
	})
	return html`
		<button
			class="ghost small foot-toggle schedule-toggle"
			type="button"
			aria-label="Scheduled tasks"
			title="Every scheduled task in the house"
			ref=${(el) => (button = el)}
			popovertarget=${id}
		>
			<span>Scheduled</span>
		</button>
		<div
			class="popover schedule-list"
			id=${id}
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				const opening = event.newState === 'open'
				if (opening) placePopover(panel, button)
				else setForm(null)
				setOpen(opening)
			}}
		>
			<${Panes}
				title="Scheduled tasks"
				actions=${html`<button
					type="button"
					class="small"
					onClick=${(_event) => setForm({ thread: undefined })}
				>
					New task
				</button>`}
				open=${() => Boolean(form())}
				detailTitle=${() => (form()?.task ? 'Edit task' : 'New task')}
				detail=${html`<${Show} when=${form} keyed
					>${(asked) =>
						html`<${TaskForm}
							thread=${asked.thread}
							task=${asked.task}
							onDone=${(_event) => setForm(null)}
							onOpen=${(_event) => panel.hidePopover()}
						/>`}<//
				>`}
				onBack=${(_event) => setForm(null)}
				onClose=${(_event) => panel.hidePopover()}
			>
				<${Show} when=${open}>
					<ul class="rows">
						<${For} each=${tasks} keyed=${(task) => task.id}
							>${(task) =>
								html`<${TaskRow}
									task=${() => task()}
									path="/api/schedule"
									place
									onGo=${(_e) => setForm({ thread: task().thread, task: task() })}
									onOpen=${(_e) => panel.hidePopover()}
								/>`}<//
						>
					</ul>
					<${Show} when=${() => tasks().length === 0}><p class="mute">Nothing scheduled.</p><//>
				<//>
			<//>
		</div>
	`
}

/** The bot used last, whose home a task from the list runs in unless you choose otherwise */
const lastBot = () =>
	[...bots].sort((a, b) => String(b.answeredAt ?? '').localeCompare(String(a.answeredAt ?? '')))[0]

/** A datetime-local field's value for `ms`, on this device's clock */
const localField = (ms) => {
	const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000)
	return date.toISOString().slice(0, 16)
}

/** Tomorrow at 09:00 here */
const tomorrowAtNine = () => {
	const date = new Date()
	date.setDate(date.getDate() + 1)
	date.setHours(9, 0, 0, 0)
	return date.getTime()
}

/** Every so often, in the form's units */
const UNIT_SIZES = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const everyIn = (ms) => {
	for (const unit of ['d', 'h', 'm'])
		if (ms % UNIT_SIZES[unit] === 0) return { count: ms / UNIT_SIZES[unit], unit }
	return { count: Math.round(ms / 60_000), unit: 'm' }
}

/** A run on the timeline: Tue 09:00, the weekday dropped for today */
const runLabel = (ms, timeZone = HERE) => {
	const clock = new Date(ms).toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
		timeZone,
	})
	const day = (at) =>
		new Date(at).toLocaleDateString('en-GB', {
			weekday: 'short',
			day: 'numeric',
			month: 'numeric',
			timeZone,
		})
	return day(ms) === day(Date.now()) ? clock : `${day(ms).split(' ')[0]} ${clock}`
}

/** Night, when a run is more likely a slip than a wish */
const atNight = (ms, timeZone = HERE) => {
	const hour = Number(
		new Date(ms).toLocaleTimeString('en-GB', {
			hour: '2-digit',
			hourCycle: 'h23',
			timeZone,
		}),
	)
	return hour < 6 || hour >= 23
}

/**
 * A task's form, new or to edit: its instructions, where it runs (a bot's home, a thread, or a new thread each run with
 * the model you pick), and when, in plain fields: once at a date and time, every so often from an optional start, or at
 * clock times on chosen weekdays. Under them its schedule itself: the last runs, each opening what it posted, and the
 * next five as they'd come, redrawn as you type, then the thread it runs in. From a thread, it runs there; from the
 * list, with the bot used last.
 */
function TaskForm(props) {
	let pickButton, pickPanel
	const task = props.task
	const hooks = () => server().modules.includes('hooks')
	const checks = () => server().modules.includes('check') || Boolean(task?.check)
	/** The quiet or failed run whose check output shows under the timeline */
	const [shown, setShown] = createSignal(null)
	const agentTask = task?.agent !== undefined
	const [place, setPlace] = createSignal(
		task
			? task.bot !== undefined
				? `bot ${task.bot}`
				: task.to
					? 'new'
					: `thread ${task.thread}`
			: props.thread !== undefined
				? homeBot(props.thread)
					? `bot ${homeBot(props.thread).name}`
					: `thread ${props.thread}`
				: lastBot()
					? `bot ${lastBot().name}`
					: 'new',
	)
	/** Its thread's own agents, as the composer's pick would choose among them */
	const agentsOf = (threadId) => threadOf(threadId)?.agents ?? []
	/** The key a run asks it by: a bot's name, or `agent` for the thread's own */
	const keyOf = (agent) => agent.to?.name ?? 'agent'
	const labelOf = (agent) => agent.to?.name ?? shortLabel(agent.name)
	const threadIdOf = () => {
		const [where, value] = place().split(/ (.*)/)
		return where === 'thread' ? Number(value) : undefined
	}
	/** Its thread's own agents, there's more than one to choose among */
	const threadAgents = () => agentsOf(threadIdOf())
	/** Who it asks there: everyone, unless the task already says otherwise */
	const [who, setWho] = createSignal(task?.recipients ?? threadAgents().map(keyOf))
	const schedule = task?.schedule ?? {}
	const zone = schedule.timeZone ?? HERE
	const [kind, setKind] = createSignal(
		schedule.on !== undefined
			? 'on'
			: schedule.after !== undefined
				? 'after'
				: schedule.when !== undefined
					? Object.keys(schedule.when)[0]
					: schedule.every
						? 'every'
						: schedule.times || !task
							? 'days'
							: 'once',
	)
	const [once, setOnce] = createSignal(
		localField(schedule.at !== undefined && !schedule.every ? schedule.at : tomorrowAtNine()),
	)
	const every = everyIn(schedule.every ?? 3_600_000)
	const [count, setCount] = createSignal(String(every.count))
	const [unit, setUnit] = createSignal(every.unit)
	const [start, setStart] = createSignal(schedule.every ? localField(schedule.at) : '')
	const [days, setDays] = createSignal(schedule.days ?? [0, 1, 2, 3, 4, 5, 6])
	const [times, setTimes] = createSignal(schedule.times ?? ['09:00'])
	const [runner, setRunner] = createSignal(
		schedule.when?.online ??
			schedule.when?.offline ??
			runners.find((one) => !one.online)?.name ??
			runners[0]?.name,
	)
	const [watched, setWatched] = createSignal(
		schedule.when?.failed ?? schedule.when?.answered ?? props.thread ?? threadRows().open[0]?.id,
	)
	/** Whether it repeats, so it can end: never, `until` a time, or after `count` runs */
	const repeats = () => ['every', 'days', 'on'].includes(kind())
	const [ends, setEnds] = createSignal(
		schedule.count !== undefined ? 'count' : schedule.until !== undefined ? 'until' : 'never',
	)
	const [until, setUntil] = createSignal(localField(schedule.until ?? Date.now() + 2 * 3_600_000))
	const [runs, setRuns] = createSignal(String(schedule.count ?? 10))
	const [to, setTo] = createSignal(task?.to ?? null)
	const [saving, setSaving] = createSignal(false)
	const online = () => runners.filter((runner) => runner.online)
	const chosen = () => to() ?? { runner: online()[0]?.name, model: online()[0]?.model }
	/** A few threads to pick from: this one, then the open ones most recently active */
	const threads = () => {
		const rows = threadRows().open.filter((row) => !homeBot(row.id))
		const mine = task && !task.bot && !task.to ? task.thread : props.thread
		const here = rows.find((row) => row.id === mine)
		return [...(here ? [here] : []), ...rows.filter((row) => row !== here).slice(0, 30)]
	}
	/** When, as the server takes it: exactly what the fields say, and how it ends */
	const when = () => {
		if (kind() in HAPPENINGS)
			return {
				when: {
					[kind()]: HAPPENINGS[kind()].runner ? runner() : Number(watched()),
				},
			}
		if (kind() === 'after') return { after: schedule.after }
		if (kind() === 'once') return { at: new Date(once()).getTime() }
		return { ...startsAt(), ...ending() }
	}
	const startsAt = () => {
		if (kind() === 'on') return { on: schedule.on ?? 'hook' }
		if (kind() === 'every')
			return {
				every: `${Number(count())}${unit()}`,
				...(start() ? { at: new Date(start()).getTime() } : {}),
			}
		return {
			times: times().filter(Boolean),
			days: days(),
			timeZone: zone,
		}
	}
	const ending = () =>
		ends() === 'until'
			? { until: new Date(until()).toISOString() }
			: ends() === 'count'
				? { count: Number(runs()) }
				: {}
	/** The same as a schedule, to draw its next runs */
	const planned = () => {
		if (!['once', 'every', 'days'].includes(kind())) return null
		const asked = /** @type {any} */ (when())
		if (asked.times)
			return {
				...asked,
				days: asked.days.length === 7 ? undefined : asked.days,
			}
		if (asked.every) {
			const gap = Number(count()) * UNIT_SIZES[unit()]
			if (!(gap >= 60_000)) return null
			return { at: asked.at ?? now() + gap, every: gap }
		}
		return asked.at === undefined || Number.isNaN(asked.at) ? null : asked
	}
	const next = () => {
		const schedule = planned()
		if (!schedule) return []
		if (schedule.times && (!schedule.times.length || schedule.days?.length === 0)) return []
		const end = ends() === 'until' ? new Date(until()).getTime() : Infinity
		const left =
			ends() === 'count'
				? Math.max(0, Number(runs()) - (task?.schedule.count === undefined ? 0 : (task.ran ?? 0)))
				: 5
		return runsAfter(schedule, now(), Math.min(5, left)).filter((at) => at <= end)
	}
	const placeLink = () => {
		const [where, value] = place().split(/ (.*)/)
		if (where === 'bot') {
			const bot = bots.find((one) => one.name === value)
			return bot && { thread: bot.home, label: `${value}'s home` }
		}
		if (where === 'thread') return null
		return task?.to
			? {
					thread: task.thread,
					label: `a new thread each run, under ${titleOf(task.thread)}`,
				}
			: { label: 'a new thread each run' }
	}
	const submit = async (event) => {
		event.preventDefault()
		const fields = new FormData(event.currentTarget)
		const [where, value] = place().split(/ (.*)/)
		const body = {
			...(task ? { edit: task.id } : { key: crypto.randomUUID() }),
			instructions: String(fields.get('instructions') ?? ''),
			...(agentTask
				? {}
				: where === 'bot'
					? { bot: value }
					: where === 'thread'
						? { thread: Number(value), recipients: who() }
						: { to: chosen() }),
			...when(),
			...(checks() && (task || fields.get('check'))
				? { check: String(fields.get('check') ?? '') }
				: {}),
		}
		setSaving(true)
		try {
			await api('/api/schedule', body)
			props.onDone()
		} catch (error) {
			report(error)
		} finally {
			setSaving(false)
		}
	}
	const toggleDay = (day) =>
		setDays((list) =>
			list.includes(day) ? list.filter((one) => one !== day) : [...list, day].sort(),
		)
	return html`
		<form class="bot task-form" onSubmit=${submit}>
			<h3>Instructions</h3>
			<textarea
				class="instructions"
				name="instructions"
				rows="4"
				required
				aria-label="Instructions"
				placeholder="What to do each time it runs"
				value=${task?.instructions ?? ''}
			></textarea>
			<h3>When</h3>
			<select aria-label="When" onChange=${(event) => setKind(event.currentTarget.value)}>
				<option value="once" selected=${() => kind() === 'once'}>Once</option>
				<option value="every" selected=${() => kind() === 'every'}>Every so often</option>
				<option value="days" selected=${() => kind() === 'days'}>At times of day</option>
				<${Show} when=${() => schedule.after !== undefined}>
					<option value="after" selected=${() => kind() === 'after'}>
						${() => `Once ${titleOf(schedule.after)} is done`}
					</option>
				<//>
				<${Show} when=${() => hooks() || schedule.on !== undefined}>
					<option value="on" selected=${() => kind() === 'on'}>
						${`On ${EVENTS[schedule.on ?? 'hook']}`}
					</option>
				<//>
				<optgroup label="When something happens">
					<${For} each=${Object.keys(HAPPENINGS)}
						>${(name) =>
							html`<option value=${name} selected=${() => kind() === name}>
								${HAPPENINGS[name].label}
							</option>`}<//
					>
				</optgroup>
			</select>
			<${Show} when=${() => HAPPENINGS[kind()]?.runner}>
				<div class="when">
					<span>when</span>
					<select aria-label="Runner" onChange=${(event) => setRunner(event.currentTarget.value)}>
						<${For} each=${() => runners}
							>${(one) =>
								html`<option value=${() => one.name} selected=${() => runner() === one.name}>
									${() => one.name}
								</option>`}<//
						>
					</select>
					<span>${() => (kind() === 'online' ? 'comes online' : 'goes offline')}</span>
				</div>
			<//>
			<${Show} when=${() => kind() === 'failed' || kind() === 'answered'}>
				<div class="when">
					<span>when</span>
					<select
						aria-label="Thread"
						onChange=${(event) => setWatched(Number(event.currentTarget.value))}
					>
						<${For} each=${threads}
							>${(row) =>
								html`<option value=${() => row.id} selected=${() => watched() === row.id}>
									${() => titleOf(row.id)}
								</option>`}<//
						>
					</select>
					<span>${() => (kind() === 'failed' ? 'fails' : 'answers')}</span>
				</div>
			<//>
			<${Show} when=${() => kind() === 'once'}>
				<div class="when">
					<input
						type="datetime-local"
						aria-label="Date and time"
						required
						value=${once()}
						onInput=${(event) => setOnce(event.currentTarget.value)}
					/>
				</div>
			<//>
			<${Show} when=${() => kind() === 'every'}>
				<div class="when">
					<span>every</span>
					<input
						type="number"
						class="count"
						min="1"
						required
						aria-label="How many"
						value=${count()}
						onInput=${(event) => setCount(event.currentTarget.value)}
					/>
					<select aria-label="Unit" onChange=${(event) => setUnit(event.currentTarget.value)}>
						<option value="m" selected=${unit() === 'm'}>minutes</option>
						<option value="h" selected=${unit() === 'h'}>hours</option>
						<option value="d" selected=${unit() === 'd'}>days</option>
					</select>
				</div>
				<div class="when">
					<span>from</span>
					<input
						type="datetime-local"
						aria-label="Starting"
						value=${start()}
						onInput=${(event) => setStart(event.currentTarget.value)}
					/>
					<${Show} when=${() => !start()}><small>now</small><//>
				</div>
			<//>
			<${Show} when=${() => kind() === 'days'}>
				<div class="when days" role="group" aria-label="Days">
					<${For} each=${[1, 2, 3, 4, 5, 6, 0]}
						>${(day) =>
							html`<button
								type="button"
								class="ghost small"
								aria-pressed=${() => String(days().includes(day))}
								aria-label=${DAYS[day].slice(0, -1)}
								onClick=${(_event) => toggleDay(day)}
							>
								${DAY_KEYS[day].slice(0, 2).replace(/^./, (first) => first.toUpperCase())}
							</button>`}<//
					>
				</div>
				<div class="when times">
					<${For} each=${() => times().map((_, index) => index)}
						>${(index) =>
							html`<span class="time"
								><input
									type="time"
									required
									aria-label="Time"
									value=${times()[index]}
									onInput=${(event) =>
										setTimes((list) =>
											list.map((one, at) => (at === index ? event.currentTarget.value : one)),
										)} /><${Show} when=${() => times().length > 1}
									><button
										type="button"
										class="ghost small"
										aria-label="Remove this time"
										onClick=${(_event) => setTimes((list) => list.filter((_, at) => at !== index))}
									>
										<${Icon} name="close" /></button><//
							></span>`}<//
					>
					<button
						type="button"
						class="ghost small"
						aria-label="Add a time"
						onClick=${(_event) => setTimes((list) => [...list, '17:00'])}
					>
						<${Icon} name="plus" />
					</button>
					<${Show} when=${() => zone !== HERE}><small>${zone}</small><//>
				</div>
			<//>
			<${Show} when=${repeats}>
				<div class="when">
					<span>ends</span>
					<select aria-label="Ends" onChange=${(event) => setEnds(event.currentTarget.value)}>
						<option value="never" selected=${() => ends() === 'never'}>never</option>
						<option value="until" selected=${() => ends() === 'until'}>at</option>
						<option value="count" selected=${() => ends() === 'count'}>after</option>
					</select>
					<${Show} when=${() => ends() === 'until'}>
						<input
							type="datetime-local"
							aria-label="Ends at"
							required
							value=${until()}
							onInput=${(event) => setUntil(event.currentTarget.value)}
						/>
					<//>
					<${Show} when=${() => ends() === 'count'}>
						<input
							type="number"
							class="count"
							min="1"
							required
							aria-label="Runs"
							value=${runs()}
							onInput=${(event) => setRuns(event.currentTarget.value)}
						/>
						<span>${() => (Number(runs()) === 1 ? 'run' : 'runs')}</span>
					<//>
				</div>
			<//>
			<${Show} when=${() => task?.runs?.length || next().length}>
				<p class="timeline" aria-label="Runs">
					<${For} each=${() => task?.runs ?? []}
						>${(run) =>
							run.skipped
								? html`<s class="ran">${`${runLabel(run.at, zone)} skipped: ${run.skipped}`}</s>`
								: run.checked || run.failed
									? html`<button
											type="button"
											class=${{ ran: true, quiet: Boolean(run.checked), failed: Boolean(run.failed) }}
											aria-pressed=${() => String(shown() === run)}
											title=${run.failed ? `Its check failed: ${run.failed}` : 'Its check ran and asked no one'}
											onClick=${(_event) => setShown((was) => (was === run ? null : run))}
										>
											${`${runLabel(run.at, zone)} ${run.failed ? 'failed' : `quiet${run.checked > 1 ? ` ×${run.checked}` : ''}`}`}
										</button>`
									: html`<a
											class="ran"
											href=${hrefOf(run.thread)}
											onClick=${(event) => {
												event.preventDefault()
												props.onOpen?.()
												showMessage(run.thread, run.entry)
											}}
											>${runLabel(run.at, zone)}</a
										>`}<//
					>
					<${Show} when=${() => task?.runs?.length && next().length}
						><span class="now" aria-label="now">|</span><//
					>
					<${For} each=${next}
						>${(at) =>
							html`<span class=${() => ({ next: true, night: atNight(at, zone) })}
								>${() => runLabel(at, zone)}</span
							>`}<//
					>
				</p>
			<//>
			<${Show} when=${shown}>
				<pre class="check-output">
${() =>
	[shown().failed, shown().output || 'It printed nothing.'].filter(Boolean).join(NEWLINE)}</pre>
			<//>
			<${Show} when=${checks}>
				<details class="check" open=${Boolean(task?.check)}>
					<summary>Check first</summary>
					<textarea
						class="code"
						name="check"
						rows="6"
						spellcheck="false"
						aria-label="Check"
						disabled=${() => place() === 'new' && !agentTask}
						placeholder="A script that runs before each run, with no model. post(text) asks, done() ends the task, keep(value) is input.state next time; nothing, and the run stays quiet."
						value=${task?.check ?? ''}
					></textarea>
					<small class="mute"
						>${() =>
							place() === 'new' && !agentTask
								? 'A task that starts a new thread each run has no agent to check as.'
								: 'It runs as the agent the run asks, on its runner, with its tools.'}</small
					>
				</details>
			<//>
			<h3>Runs in</h3>
			<${Show}
				when=${() => !agentTask}
				fallback=${html`<p class="mute runs-in">
					${`As ${shortLabel(task?.agent ?? '')}'s own message, in `}<a
						class="thread-link"
						href=${hrefOf(task?.thread)}
						onClick=${(event) => {
							event.preventDefault()
							props.onOpen?.()
							openThread(task.thread)
						}}
						>${() => titleOf(task?.thread)}</a
					>
				</p>`}
			>
				<select
					aria-label="Runs in"
					onChange=${(event) => {
						setPlace(event.currentTarget.value)
						const [where, value] = event.currentTarget.value.split(/ (.*)/)
						setWho(where === 'thread' ? agentsOf(Number(value)).map(keyOf) : [])
					}}
				>
					<${Show} when=${() => bots.length}>
						<optgroup label="A bot, in her home">
							<${For} each=${() => bots}
								>${(bot) =>
									html`<option
										value=${() => `bot ${bot.name}`}
										selected=${() => place() === `bot ${bot.name}`}
									>
										${() => bot.name}
									</option>`}<//
							>
						</optgroup>
					<//>
					<optgroup label="A thread">
						<${For} each=${threads}
							>${(row) =>
								html`<option
									value=${() => `thread ${row.id}`}
									selected=${() => place() === `thread ${row.id}`}
								>
									${() => titleOf(row.id)}
								</option>`}<//
						>
					</optgroup>
					<option value="new" selected=${() => place() === 'new'}>A new thread each run</option>
				</select>
				<${Show} when=${placeLink}
					><p class="mute runs-in">
						<${Show}
							when=${() => placeLink()?.thread !== undefined}
							fallback=${() => placeLink()?.label}
						>
							<a
								class="thread-link"
								href=${() => hrefOf(placeLink().thread)}
								onClick=${(event) => {
									event.preventDefault()
									props.onOpen?.()
									openThread(placeLink().thread)
								}}
								>${() => placeLink().label}</a
							>
						<//>
					</p><//
				>
			<//>
			<${Show} when=${() => threadIdOf() !== undefined && threadAgents().length > 1}>
				<h3>To</h3>
				<div class="when recipients" role="group" aria-label="Who it asks">
					<${For} each=${threadAgents}
						>${(agent) =>
							html`<button
								type="button"
								class="ghost small"
								aria-pressed=${() => String(who().includes(keyOf(agent)))}
								onClick=${(_event) =>
									setWho((list) =>
										list.includes(keyOf(agent))
											? list.filter((key) => key !== keyOf(agent))
											: [...list, keyOf(agent)],
									)}
							>
								${() => labelOf(agent)}
							</button>`}<//
					>
				</div>
			<//>
			<${Show} when=${() => place() === 'new' && !agentTask}>
				<h3>Model</h3>
				<button
					type="button"
					class="bot-model"
					aria-haspopup="true"
					ref=${(el) => (pickButton = el)}
					onClick=${(_event) => pickPanel.togglePopover()}
				>
					${() =>
						chosen().model
							? `${chosen().model.split('/').pop()}${chosen().thinkingLevel ? `:${thinkingWord(chosen().thinkingLevel)}` : ''}@${chosen().runner}`
							: 'Pick a model'}
				</button>
				<div
					class="popover model-picker"
					popover
					ref=${(el) => (pickPanel = el)}
					onToggle=${(event) => {
						if (event.newState === 'open') placePopover(pickPanel, pickButton)
					}}
				>
					<${ModelPicker}
						getTo=${(runner) =>
							chosen().runner === runner.name
								? chosen()
								: { runner: runner.name, model: runner.model }}
						selectedRunner=${() => chosen().runner}
						onChoose=${(next) => {
							setTo(next)
							pickPanel.hidePopover()
						}}
						onConfigure=${(next) => setTo(next)}
						onClose=${(_e) => pickPanel.hidePopover()}
					/>
				</div>
			<//>
			<div class="actions">
				<button type="submit" disabled=${saving}>${task ? 'Save' : 'Schedule'}</button>
			</div>
		</form>
	`
}

/**
 * The thread's scheduled tasks above its composer, streamed over the schedule/<id> feed: one quiet line each, its ring,
 * how it repeats and the start of its instructions; opened, the whole of them, its next run and its buttons
 */
export function ScheduledTasks(props) {
	const tasks = feedView(() => (props.thread ? `schedule/${props.thread}` : null), {
		sort: taskSort,
	})
	return html`
		<${For} each=${tasks} keyed=${(task) => task.id}
			>${(task) => {
				const [open, setOpen] = createSignal(false)
				/** Opened, a webhook task shows the owner where its hook is and its secret; anyone else, nothing */
				const [hook, setHook] = createSignal('')
				const toggle = () => {
					const opening = !open()
					setOpen(opening)
					if (opening && task().schedule.on !== undefined && !hook())
						api(`/api/threads/${props.thread}/hooks?task=${task().id}`).then(
							(found) => setHook(`, ${found.path}, secret ${found.secret}`),
							() => {},
						)
				}
				return html`
					<p class=${() => ({ notice: true, open: open(), paused: task().paused })} role="status">
						<${Show} when=${() => task().from ?? `none ${task().paused}`} keyed
							>${() => html`<${Ring} task=${() => task()} />`}<//
						>
						<span class="line" onClick=${(_e) => toggle()}
							>${() =>
								open()
									? `${whenOf(task())}: ${task().instructions}${hook()}`
									: `${shortWhen(task())}: ${task().instructions}`}</span
						>
						<${Show} when=${open}>
							<button
								type="button"
								class="ghost small"
								onClick=${(_e) => openTaskForm(props.thread, task())}
							>
								edit
							</button>
							<${Controls}
								task=${() => task()}
								path=${() => `/api/threads/${props.thread}/schedule`}
							/>
						<//>
					</p>
				`
			}}<//
		>
	`
}

/** A schedule call's own row in the chat, one quiet line: a clock, who, when, the instructions cut off; opened, whole */
export function ScheduledTaskSet(props) {
	const when = () => {
		const args = props.step.args
		const end = [
			args.until ? `until ${args.until}` : '',
			args.count ? `${args.count} run${args.count === 1 ? '' : 's'}` : '',
		].filter(Boolean)
		return [started(args), ...end].join(', ')
	}
	const started = (args) => {
		if (args.cancel !== undefined) return 'cancelled a scheduled task'
		if (args.on !== undefined) return `scheduled a task on ${EVENTS[args.on] ?? args.on}`
		if (args.after !== undefined) return `scheduled a task for once ${titleOf(args.after)} is done`
		if (args.when !== undefined) return `scheduled a task for ${happening(args.when)}`
		if (args.times)
			return `scheduled a task ${args.days ? listed([args.days].flat()) : 'daily'} at ${listed([args.times].flat())}`
		if (args.every)
			return `scheduled a task every ${args.every}${args.at ? ` from ${args.at}` : args.in ? ` in ${args.in}` : ''}`
		return `scheduled a task ${args.at ? `at ${args.at}` : `in ${args.in}`}`
	}
	const instructions = () => props.step.args.instructions
	return html`
		<${PlainStep}
			icon="clock"
			said=${() => `${shortLabel(props.agent.name)} ${when()}${instructions() ? `: ${instructions()}` : ''}`}
			label=${() => `${shortLabel(props.agent.name)} ${when()}`}
		>
			<${Show} when=${instructions}
				><div class="whole"><p>${instructions}</p></div><//
			>
		<//>
	`
}

/** A scheduled task's run, back in the thread: one quiet folded line of its own; opened, the whole instructions, what
 * an outside event brought and what its check found */
export const ScheduledRun = (props) => html`
	<${PlainStep}
		icon="clock"
		said=${() => firstLine(props.data.body)}
		label="scheduled task"
		entry=${() => props.entry}
	>
		<div class="whole">
			<p>${() => props.data.body}</p>
			<${Show} when=${() => props.data.event}>
				<p class="outside">
					${() =>
						[
							`from ${props.data.event.from}, outside ade:`,
							...Object.entries(props.data.event.facts ?? {}).map(
								([name, value]) => `${name}: ${value}`,
							),
							...(props.data.event.said === undefined ? [] : [props.data.event.said]),
						].join(NEWLINE)}
				</p>
			<//>
			<${Show} when=${() => props.data.checked}>
				<p class="outside">${() => `its check found:${NEWLINE}${props.data.checked}`}</p>
			<//>
		</div>
	<//>
`
const NEWLINE = String.fromCharCode(10)
const firstLine = (text) => (text ?? '').split(/\r?\n/)[0]
