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

/** What a task can run `on`, as the server's hooks.js says it */
const EVENTS = {
	push: 'each GitHub push',
	ci: 'each failed GitHub CI run',
	hook: 'each call to its hook',
}
const DAYS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays']
const HERE = Intl.DateTimeFormat().resolvedOptions().timeZone

/** `5m`, `1h30m` from milliseconds, as the agent wrote it */
const UNITS = /** @type {[number, string][]} */ ([
	[86_400_000, 'd'],
	[3_600_000, 'h'],
	[60_000, 'm'],
	[1000, 's'],
])
const span = (ms) => {
	let text = ''
	for (const [size, unit] of UNITS)
		if (ms >= size) [text, ms] = [`${text}${Math.floor(ms / size)}${unit}`, ms % size]
	return text
}

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

/** How a schedule repeats, or what it waits for */
const repeatOf = (schedule) => {
	if (schedule.on !== undefined) return `on ${EVENTS[schedule.on]}`
	if (schedule.after !== undefined) return `once ${titleOf(schedule.after)} is done`
	if (schedule.every) return `every ${span(schedule.every)}`
	if (!schedule.repeat) return 'once'
	const zone = schedule.timeZone === HERE ? '' : ` ${schedule.timeZone}`
	const two = (number) => String(number).padStart(2, '0')
	if (schedule.repeat === 'hourly') return `hourly at :${two(schedule.minute)}${zone}`
	const days = schedule.repeat === 'weekly' ? DAYS[schedule.dayOfWeek] : schedule.repeat
	return `${days} at ${two(schedule.hour)}:${two(schedule.minute)}${zone}`
}

/** When it runs next and how it repeats: in 8m, daily at 09:00; paused, why, then how it repeats */
const whenOf = (task) =>
	task.paused
		? `paused${task.note ? ` (${task.note})` : ''}, ${repeatOf(task.schedule)}`
		: [task.at === undefined ? '' : countdown(task.at), repeatOf(task.schedule)]
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
								api('/api/schedule', { move: props.task.id, runner: runner.name }).catch(report)
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

/** Its last run: when, opening the message it posted; or that it was skipped, and why */
function LastRun(props) {
	return html`
		<${Show} when=${() => props.task.last}>
			<small>
				<${Show}
					when=${() => !props.task.last.skipped}
					fallback=${html`${() => `Last run skipped at ${whenWas(props.task.last.at)}: ${props.task.last.skipped}`}`}
				>
					<a
						class="thread-link"
						href=${() => hrefOf(props.task.last.thread)}
						onClick=${(event) => {
							event.preventDefault()
							event.stopPropagation()
							props.onOpen?.()
							showMessage(props.task.last.thread, props.task.last.entry)
						}}
						>${() => `Last run ${whenWas(props.task.last.at)}`}</a
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
		act({ pause: props.task.id, ...(note.trim() ? { note: note.trim() } : {}) })
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

/** Asked to open the form from somewhere else, as `{thread}`: the list opens on it */
const [asked, setAsked] = createSignal(null)
/** Opens the New task form, for `thread` if given, else for the bot last used */
export const openTaskForm = (thread) => setAsked({ thread })

/**
 * Every task in the house, in a popover from the list's foot: where it runs, when, its instructions, pause and ×; New
 * task opens the form over it. Fetched when it opens and, while open, on each change.
 */
export function ScheduledTaskList() {
	let button, panel
	const id = createUniqueId()
	const [open, setOpen] = createSignal(false)
	const [form, setForm] = createSignal(null)
	const tasks = feedView(() => (open() ? 'schedule' : null), { sort: taskSort })
	/** A row opens its thread */
	const go = (task) => {
		panel.hidePopover()
		openThread(task.thread)
	}
	const openForm = (thread) => {
		setForm({ thread })
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
		openForm(wish.thread)
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
					class="ghost small"
					onClick=${(_event) => setForm({ thread: undefined })}
				>
					New task
				</button>`}
				open=${() => Boolean(form())}
				detailTitle="New task"
				detail=${html`<${Show} when=${form} keyed
					>${(asked) =>
						html`<${TaskForm} thread=${asked.thread} onDone=${(_event) => setForm(null)} />`}<//
				>`}
				onBack=${(_event) => setForm(null)}
				onClose=${(_event) => panel.hidePopover()}
			>
				<${Show} when=${open}>
					<ul class="rows">
						<${For} each=${tasks} keyed=${(task) => task.id}
							>${(task) => html`
								<li
									role="button"
									tabindex="0"
									class=${() => ({ paused: task().paused })}
									title=${() => `${whenOf(task())}: ${task().instructions}`}
									onClick=${(_e) => go(task())}
									onKeyDown=${(event) =>
										event.key === 'Enter' && event.target === event.currentTarget && go(task())}
								>
									<${Show} when=${() => task().from ?? `none ${task().paused}`} keyed
										>${() => html`<${Ring} task=${() => task()} />`}<//
									>
									<div>
										<b>${() => placeOf(task())}</b>
										<small
											>${() =>
												task().paused
													? `P${whenOf(task()).slice(1)}`
													: `Next ${whenOf(task())}`}</small
										>
										<${LastRun} task=${() => task()} onOpen=${() => panel.hidePopover()} />
										<${OfflineRunner} task=${() => task()} />
										<small class="said"
											>${() => `${shortLabel(task().by)}: ${task().instructions}`}</small
										>
									</div>
									<div class="controls">
										<${Controls} task=${() => task()} path="/api/schedule" />
									</div>
								</li>
							`}<//
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

/**
 * A new task: its instructions, where it runs (a bot's home, a thread, or a new thread each run with the model you
 * pick), how it repeats and at what time of day here. From a thread, it runs there; from the list, with the bot used last.
 */
function TaskForm(props) {
	let pickButton, pickPanel
	const hooks = () => server().modules.includes('hooks')
	const [place, setPlace] = createSignal(
		props.thread !== undefined
			? homeBot(props.thread)
				? `bot ${homeBot(props.thread).name}`
				: `thread ${props.thread}`
			: lastBot()
				? `bot ${lastBot().name}`
				: 'new',
	)
	const [repeat, setRepeat] = createSignal('daily')
	const [to, setTo] = createSignal(null)
	const [saving, setSaving] = createSignal(false)
	const online = () => runners.filter((runner) => runner.online)
	const chosen = () => to() ?? { runner: online()[0]?.name, model: online()[0]?.model }
	/** A few threads to pick from: this one, then the open ones most recently active */
	const threads = () => {
		const rows = threadRows().open.filter((row) => !homeBot(row.id))
		const here = rows.find((row) => row.id === props.thread)
		return [...(here ? [here] : []), ...rows.filter((row) => row !== here).slice(0, 30)]
	}
	const submit = async (event) => {
		event.preventDefault()
		const fields = new FormData(event.currentTarget)
		const [kind, value] = place().split(/ (.*)/)
		const body = {
			instructions: String(fields.get('instructions') ?? ''),
			...(kind === 'bot'
				? { bot: value }
				: kind === 'thread'
					? { thread: Number(value) }
					: { to: chosen() }),
			repeat: repeat(),
			...(repeat() === 'webhook'
				? {}
				: {
						hour: Number(String(fields.get('time')).split(':')[0]),
						minute: Number(String(fields.get('time')).split(':')[1]),
					}),
			...(repeat() === 'weekly' ? { dayOfWeek: Number(fields.get('day')) } : {}),
			timeZone: HERE,
			key: crypto.randomUUID(),
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
			></textarea>
			<h3>Runs in</h3>
			<select aria-label="Runs in" onChange=${(event) => setPlace(event.currentTarget.value)}>
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
			<${Show} when=${() => place() === 'new'}>
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
			<h3>Repeat</h3>
			<select aria-label="Repeat" onChange=${(event) => setRepeat(event.currentTarget.value)}>
				<option value="once">Once</option>
				<option value="hourly">Hourly</option>
				<option value="daily" selected>Daily</option>
				<option value="weekdays">Weekdays</option>
				<option value="weekly">Weekly</option>
				<${Show} when=${hooks}><option value="webhook">On a webhook</option><//>
			</select>
			<${Show} when=${() => repeat() !== 'webhook'}>
				<h3>${() => (repeat() === 'hourly' ? 'Minutes past the hour' : 'Time')}</h3>
				<div class="when">
					<${Show} when=${() => repeat() === 'weekly'}>
						<select name="day" aria-label="Day">
							<${For} each=${DAYS.map((_, index) => index)}
								>${(index) =>
									html`<option value=${String(index)} selected=${index === new Date().getDay()}>
										${DAYS[index].slice(0, -1)}
									</option>`}<//
							>
						</select>
					<//>
					<input type="time" name="time" required aria-label="Time" value="09:00" />
					<small>${HERE}</small>
				</div>
			<//>
			<div class="actions">
				<button type="submit" disabled=${saving}>Schedule</button>
			</div>
		</form>
	`
}

/** The thread's scheduled tasks above its composer, streamed over the schedule/<id> feed */
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
						<span
							class="line"
							title=${() => `${shortLabel(task().by)}, ${whenOf(task())}: ${task().instructions}`}
							onClick=${(_e) => toggle()}
							>${() =>
								`Scheduled${task().paused ? ',' : ''} ${whenOf(task())}: ${task().instructions}${open() ? hook() : ''}`}</span
						>
						<${Controls}
							task=${() => task()}
							path=${() => `/api/threads/${props.thread}/schedule`}
						/>
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
		if (args.cancel !== undefined) return 'cancelled a scheduled task'
		if (args.on !== undefined) return `scheduled a task on ${EVENTS[args.on] ?? args.on}`
		if (args.after !== undefined) return `scheduled a task for once ${titleOf(args.after)} is done`
		const clock = `${String(args.hour ?? '').padStart(2, '0')}:${String(args.minute ?? 0).padStart(2, '0')}`
		if (args.repeat)
			return `scheduled a task ${args.repeat} at ${args.repeat === 'hourly' ? `:${clock.slice(3)}` : clock}`
		if (args.hour !== undefined) return `scheduled a task at ${clock}`
		return `scheduled a task in ${args.in ?? args.every}${args.every ? `, then every ${args.every}` : ''}`
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

/** A scheduled task's run, back in the thread: one quiet folded line of its own; opened, the whole instructions and
 * what an outside event brought */
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
		</div>
	<//>
`
const NEWLINE = String.fromCharCode(10)
const firstLine = (text) => (text ?? '').split(/\r?\n/)[0]
