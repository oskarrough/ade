/** Wakes: an agent coming back to its thread later. Its pending wakes above the composer, each with ×; every wake in the house from the list's foot; the row a wake call leaves in the chat. */
import html from '@solidjs/html'
import {
	createEffect,
	createRoot,
	createSignal,
	createStore,
	createUniqueId,
	For,
	Show,
} from 'solid-js'
import { Icon } from './icons.js'
import { api, connected, openThread, titleOf, wakesChanged } from './server.js'
import { placePopover } from './popover.js'
import { Panes } from './panes.js'
import { shortLabel } from './agent.js'
import { PlainStep } from './run.js'
import { ahead } from './time.js'
import { report } from './notice.js'

/** What a wake can be `on`, as the server's wake.js says it */
const EVENTS = {
	push: 'each GitHub push',
	ci: 'each failed GitHub CI run',
	hook: 'each call to its hook',
}

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

/** Each thread's count of wake changes heard on its socket, which its strip fetches again on */
const [heard, setHeard] = createRoot(() => createStore({}))
export function heardWake(thread, event) {
	if (event.purpose === 'wake')
		setHeard((all) => {
			all[thread] = (all[thread] ?? 0) + 1
		})
}

/** When a wake goes off next, or what it waits for, and how often it repeats */
const whenOf = (wake) =>
	wake.on !== undefined
		? `on ${EVENTS[wake.on]}`
		: wake.after === undefined
			? `${ahead(wake.at)}${wake.every ? `, then every ${span(wake.every)}` : ''}`
			: `once ${titleOf(wake.after)} is done`

/** Every wake in the house, in a popover from the list's foot: its thread, when, its note, and × to cancel it; fetched when it opens and, while open, on each wake change */
export function WakeList() {
	let button, panel
	const id = createUniqueId()
	const [wakes, setWakes] = createSignal([])
	const load = () => api('/api/wake').then(setWakes, report)
	/** Open, it fetches again whenever the socket says a wake changed or comes back */
	createEffect(
		() => [wakesChanged(), connected()],
		([, online]) => {
			if (online && panel?.matches(':popover-open')) load()
		},
	)
	const cancel = (wake) => api('/api/wake', { cancel: wake.id }).catch(report)
	/** A row opens its thread */
	const go = (wake) => {
		panel.hidePopover()
		openThread(wake.thread)
	}
	return html`
		<button
			class="ghost small foot-toggle wake-toggle"
			type="button"
			aria-label="Wakes"
			title="Every wake set in the house"
			ref=${(el) => (button = el)}
			popovertarget=${id}
		>
			<span>Wakes</span>
		</button>
		<div
			class="popover wake-list"
			id=${id}
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState !== 'open') return
				placePopover(panel, button)
				load()
			}}
		>
			<${Panes} title="Wakes" open=${() => false} onClose=${(_event) => panel.hidePopover()}>
				<ul class="rows">
					<${For} each=${wakes} keyed=${(wake) => wake.id}
						>${(wake) => html`
							<li
								role="button"
								tabindex="0"
								title=${() => `${shortLabel(wake().agent)} wakes ${whenOf(wake())}: ${wake().note}`}
								onClick=${(_e) => go(wake())}
								onKeyDown=${(event) =>
									event.key === 'Enter' && event.target === event.currentTarget && go(wake())}
							>
								<div>
									<b>${() => titleOf(wake().thread)}</b>
									<small>${() => `⏰ ${whenOf(wake())}`}</small>
									<small>${() => `${shortLabel(wake().agent)}: ${wake().note}`}</small>
								</div>
								<button
									type="button"
									class="ghost small"
									aria-label="Cancel this wake"
									title="Cancel this wake"
									onClick=${(event) => {
										event.stopPropagation()
										cancel(wake())
									}}
								>
									<${Icon} name="close" />
								</button>
							</li>
						`}<//
					>
				</ul>
				<${Show} when=${() => !wakes().length}><p class="mute">No wakes set.</p><//>
			<//>
		</div>
	`
}

/** The thread's pending wakes, fetched when it opens, when the socket (re)connects, and when a wake changes */
export function Wakes(props) {
	const [wakes, setWakes] = createSignal([])
	const load = () => api(`/api/threads/${props.thread}/wake`).then(setWakes, () => setWakes([]))
	createEffect(
		() => [props.thread, connected(), heard[props.thread]],
		([, online]) => {
			if (online) load()
		},
	)
	const cancel = (id) => api(`/api/threads/${props.thread}/wake`, { cancel: id }).then(load, report)
	return html`
		<${For} each=${wakes} keyed=${(wake) => wake.id}
			>${(wake) => {
				const [open, setOpen] = createSignal(false)
				/** Opened, a hook wake shows the owner where its hook is and its secret; anyone else, nothing */
				const [hook, setHook] = createSignal('')
				const toggle = () => {
					const opening = !open()
					setOpen(opening)
					if (opening && wake().on !== undefined && !hook())
						api(`/api/threads/${props.thread}/hooks?wake=${wake().id}`).then(
							(found) => setHook(`, ${found.path}, secret ${found.secret}`),
							() => {},
						)
				}
				const when = () => whenOf(wake())
				return html`
					<p class=${() => ({ notice: true, open: open() })} role="status">
						<span
							class="line"
							title=${() => `${shortLabel(wake().agent)} wakes ${when()}: ${wake().note}`}
							onClick=${(_e) => toggle()}
							>${() => `⏰ ${when()}: ${wake().note}${open() ? hook() : ''}`}</span
						>
						<button
							type="button"
							class="ghost small"
							aria-label="Cancel this wake"
							title="Cancel this wake"
							onClick=${(_e) => cancel(wake().id)}
						>
							<${Icon} name="close" />
						</button>
					</p>
				`
			}}<//
		>
	`
}

/** A wake call's own row in the chat, one quiet line: ⏰, who, when, the note cut off; opened, the note whole */
export function WakeSet(props) {
	const when = () => {
		const args = props.step.args
		if (args.cancel !== undefined) return 'cancelled a wake'
		if (args.on !== undefined) return `wakes on ${EVENTS[args.on] ?? args.on}`
		if (args.after !== undefined) return `wakes once ${titleOf(args.after)} is done`
		return `wakes in ${args.in ?? args.every}${args.every ? `, then every ${args.every}` : ''}`
	}
	const note = () => props.step.args.note
	return html`
		<${PlainStep}
			said=${() => `⏰ ${shortLabel(props.agent.name)} ${when()}${note() ? `: ${note()}` : ''}`}
		>
			<${Show} when=${note}
				><div class="whole"><p>${note}</p></div><//
			>
		<//>
	`
}

/** A wake's note, back in the thread: one quiet folded line of its own, never part of the message above; opened,
 * the whole note and what an outside event brought */
export const Woke = (props) => html`
	<${PlainStep} said=${() => `⏰ ${firstLine(props.data.body)}`}>
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
