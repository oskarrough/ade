/**
 * A thread's trail, as a column beside it: what happened, step by step, in plain lines. A scheduled task firing, each
 * message posted and to whom, the director's wait and pick, each run started, answered, failed or stopped, and a
 * message that asked nobody. The server keeps every step with the thread, so it's all still here after a restart.
 * What happened, in a message's right-click menu, shows only that message's story.
 */
import html from '@solidjs/html'
import { createMemo, createSignal, For, Loading, Show, untrack } from 'solid-js'
import { openSide, PageTabs } from './side.js'
import { Panes } from './panes.js'
import { Dot } from './dot.js'
import { api, feedView } from './server.js'
import { showMessage } from './search.js'

/** The message each thread's column tells the story of; none shows the whole trail */
const [stories, setStories] = createSignal(new Map())
const storyIn = (id) => stories().get(id)
const tellStory = (id, entry) =>
	setStories((all) => {
		const next = new Map(all)
		if (entry === undefined) next.delete(id)
		else next.set(id, entry)
		return next
	})

/** Opens the trail beside the thread at one message's story */
export function whatHappened(id, entry) {
	tellStory(id, entry)
	openSide(id, 'trail')
}

export function Trail(props) {
	// One thread for this column's whole life
	const id = untrack(() => props.id)
	const steps = feedView(() => `trail/${id}`, { sort: (left, right) => left.id - right.id })
	// A message's story reads again as new steps land, since an answer can come long after the message
	const story = createMemo(() => {
		const entry = storyIn(id)
		if (entry === undefined) return null
		steps()
		return api(`/api/threads/${id}/trail?entry=${entry}`)
	})
	const shown = () => story() ?? steps()
	return html`
		<aside class="side trail" aria-label="Trail">
			<${Panes}
				title="Trail"
				head=${html`<${PageTabs} id=${id} />`}
				onClose=${(_event) => openSide(id, null)}
			>
				<${Show} when=${() => storyIn(id) !== undefined}>
					<p>
						<button type="button" class="ghost small" onClick=${() => tellStory(id, undefined)}>
							Whole trail
						</button>
					</p>
				<//>
				<${Loading} fallback=${html`<p class="mute">Reading the trail…</p>`}>
					<${Show}
						when=${() => shown().length}
						fallback=${html`<p class="mute">
							Nothing yet. Each step shows here as it happens: a message posted, the director's
							pick, a run started or failed.
						</p>`}
					>
						<ul class="rows">
							<${For} each=${shown} keyed=${(step) => step.id}
								>${(step) => html`
									<li class=${() => ({ mute: !important(step()) })}>
										<${Dot} state=${() => stateOf(step())} />
										<div>
											<${Show}
												when=${() => step().kind === 'posted'}
												fallback=${html`<span>${() => step().text}</span>`}
											>
												<a
													href="#"
													title="Show the message"
													onClick=${(event) => {
														event.preventDefault()
														showMessage(id, step().entry)
													}}
													>${() => step().text}</a
												>
											<//>
											<br />
											<small>${() => new Date(step().at).toLocaleTimeString()}</small>
										</div>
									</li>
								`}<//
							>
						</ul>
					<//>
				<//>
			<//>
		</aside>
	`
}

/** Where a message's story lands stands out; the rest is how it got there */
const important = (step) =>
	['posted', 'picked', 'nobody', 'answered', 'failed', 'skipped', 'ended'].includes(step.kind)
const stateOf = (step) =>
	step.kind === 'failed'
		? 'error'
		: step.kind === 'answered'
			? 'done'
			: step.kind === 'picked'
				? 'on'
				: ''
