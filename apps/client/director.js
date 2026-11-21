/**
 * A group thread's director, live, as a column beside it: each message as it arrives, the quiet it waits for, the
 * model call while it runs, a pick dropped for a newer message, and the pick with its reason. The server keeps none
 * of it; this page hears it while the thread is open, and forgets it on reload.
 */
import html from '@solidjs/html'
import { createRoot, createStore, For, Show, untrack } from 'solid-js'
import { openSide, PageTabs } from './side.js'
import { Panes } from './panes.js'
import { Dot } from './dot.js'

/** How many events a thread keeps on this page */
const KEEP = 200

/** Each thread's events, oldest first; a model call's end replaces its start */
const [activity, setActivity] = createRoot(() => createStore({}))

export function heardActivity(thread, event) {
	if (event.purpose !== 'director') return
	setActivity((all) => {
		const list = (all[thread] ??= [])
		const running =
			event.kind === 'call'
				? list.findIndex((one) => one.kind === 'call' && one.call === event.call)
				: -1
		if (running >= 0) list[running] = event
		else list.push(event)
		if (list.length > KEEP) list.splice(0, list.length - KEEP)
	})
}

export function Director(props) {
	// One thread for this column's whole life
	const id = untrack(() => props.id)
	const events = () => activity[id] ?? []
	/** What a message said, from the event that brought it */
	const bodyOf = (entry) =>
		events().find((one) => one.kind === 'message' && one.entry === entry)?.body
	return html`
		<aside class="side director" aria-label="Director">
			<${Panes}
				title="Director"
				head=${html`<${PageTabs} id=${id} />`}
				onClose=${(_event) => openSide(id, null)}
			>
				<${Show}
					when=${() => events().length}
					fallback=${html`<p class="mute">
						Nothing yet. While this thread is open, each message shows here as the director routes
						it.
					</p>`}
				>
					<ul class="rows">
						<${For} each=${events} keyed=${false}
							>${(event) => html`
								<li class=${() => ({ mute: !important(event()) })}>
									<${Dot} state=${() => stateOf(event())} />
									<div>
										<span>${() => said(event(), bodyOf)}</span><br />
										<small>${() => new Date(event().at).toLocaleTimeString()}</small>
									</div>
								</li>
							`}<//
						>
					</ul>
				<//>
			<//>
		</aside>
	`
}

const quote = (text = '') => `“${text.length > 80 ? `${text.slice(0, 80)}…` : text}”`
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`

/** A message, a pick, or a call still running stand out; the rest is how it got there */
const important = (event) =>
	['message', 'mention', 'picked'].includes(event.kind) ||
	(event.kind === 'call' && event.outcome === 'running')
const stateOf = (event) =>
	event.kind === 'picked'
		? 'on'
		: event.kind === 'call' && event.outcome === 'running'
			? 'working'
			: ''

/** One event as a sentence */
function said(event, bodyOf) {
	switch (event.kind) {
		case 'message':
			return `${event.author}: ${quote(event.body)}`
		case 'mention':
			return `${event.author}: ${quote(event.body)}, @mentioning ${event.to.join(', ')}, who answer without a pick`
		case 'wait':
			return `Waiting ${seconds(event.ms)} for more`
		case 'dropped':
			return `Dropped the pick for ${quote(bodyOf(event.entry))}: its author wrote again`
		case 'hold':
			return `Holding for ${quote(bodyOf(event.entry))}: ${event.names.join(', ')} ${event.names.length > 1 ? 'are' : 'is'} typing`
		case 'picked': {
			const sure =
				typeof event.confidence === 'number' ? ` (${Math.round(event.confidence * 100)}% sure)` : ''
			return `${event.to.length ? `Picked ${event.to.join(', ')}` : 'Picked nobody'}${event.reason ? `: ${event.reason}${sure}` : ', their next message took over'}`
		}
		case 'call': {
			const tokens = event.tokens ? `, ${event.tokens} tokens` : ''
			return {
				running: `Asking ${event.model}…`,
				ok: `${event.model} answered in ${seconds(event.ms)}${tokens}`,
				timeout: `${event.model} timed out after ${seconds(event.ms)}`,
				error: `${event.model} failed after ${seconds(event.ms)}${tokens}`,
				stopped: `${event.model} was stopped after ${seconds(event.ms)}`,
			}[event.outcome]
		}
		default:
			return event.kind
	}
}
