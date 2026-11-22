/** Wakes: an agent coming back to its thread later. Its pending wakes above the composer, each with ×; the row a wake call leaves in the chat. */
import html from '@solidjs/html'
import { createEffect, createRoot, createSignal, createStore, For, Show } from 'solid-js'
import { Icon } from './icons.js'
import { api, connected, titleOf } from './server.js'
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
				const when = () =>
					wake().on !== undefined
						? `on ${EVENTS[wake().on]}`
						: wake().after === undefined
							? `${ahead(wake().at)}${wake().every ? `, then every ${span(wake().every)}` : ''}`
							: `once ${titleOf(wake().after)} is done`
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

/** Under a message a wake posted */
export const WokeLine = (props) => html`
	<${Show} when=${() => props.data.wake}>
		<div class="links" title="An agent's own note, back at the time it set">
			⏰ its
			wake${() => (props.data.event ? `, with what came from ${props.data.event.from}, outside ade:` : '')}
		</div>
		<${Show} when=${() => props.data.event}>
			<div class="links outside">
				${() =>
					[
						...Object.entries(props.data.event.facts ?? {}).map(
							([name, value]) => `${name}: ${value}`,
						),
						...(props.data.event.said === undefined ? [] : [props.data.event.said]),
					].join('\n')}
			</div>
		<//>
	<//>
`
