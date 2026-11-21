/** Wakes: an agent coming back to its thread later. Its pending wakes above the composer, each with ×; the row a wake call leaves in the chat. */
import html from '@solidjs/html'
import { createEffect, createRoot, createSignal, createStore, For, Show } from 'solid-js'
import { Icon } from './icons.js'
import { api, colorOf, connected, titleOf } from './server.js'
import { shortLabel } from './agent.js'
import { ahead } from './time.js'
import { report } from './notice.js'

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
			>${(wake) => html`
				<p class="notice" role="status">
					<span
						>${() =>
							`⏰ ${shortLabel(wake().agent)} wakes ${wake().after === undefined ? `${ahead(wake().at)}${wake().every ? `, then every ${span(wake().every)}` : ''}` : `once ${titleOf(wake().after)} is done`}: ${wake().note}`}</span
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
			`}<//
		>
	`
}

/** A wake call's own row in the chat: who set it, when for, and the note */
export function WakeSet(props) {
	const said = () => {
		const args = props.step.args
		if (args.cancel !== undefined) return `cancelled a wake`
		if (args.after !== undefined) return `wakes once ${titleOf(args.after)} is done: ${args.note}`
		const when = args.in ?? args.every
		return `wakes in ${when}${args.every ? `, then every ${args.every}` : ''}: ${args.note}`
	}
	return html`
		<li class="elsewhere">
			<ol class="steps">
				<li class="call changed plain">
					<span class="in" style=${() => colorOf(props.agent.name)}
						>${() => `${shortLabel(props.agent.name)} ${said()}`}</span
					>
				</li>
			</ol>
		</li>
	`
}

/** Under a message a wake posted */
export const WokeLine = (props) => html`
	<${Show} when=${() => props.data.wake}>
		<div class="links" title="An agent's own note, back at the time it set">⏰ its wake</div>
	<//>
`
