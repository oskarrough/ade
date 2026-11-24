/**
 * A thread's recap, as a column beside it: a checklist of where the thread stands, a row per topic, its links
 * scrolling the thread to the message behind it. A topic that names a thread whose agent is running right now shows
 * that thread's working dot, as the thread list does; the recap itself never says what's running. The column being open is what keeps the recap written; while it's rewritten,
 * the refresh button's icon turns.
 */
import html from '@solidjs/html'
import { For, Show, untrack } from 'solid-js'
import { openSide, PageTabs } from './side.js'
import { Panes } from './panes.js'
import { Icon } from './icons.js'
import { Dot } from './dot.js'
import { api, feedItem, followThread, loadEarlier, threadOf } from './server.js'
import { inline } from './markdown.js'
import { busy, Busy } from './busy.js'
import { links, reveal } from './thread.js'

export function Recap(props) {
	// One thread for this column's whole life
	const id = untrack(() => props.id)
	const page = feedItem(() => `recap/${id}`)
	const rewrite = busy(() => api(`/api/threads/${id}/recap`, {}))
	// Turning while this column asked, or while the recap is rewritten after an answer
	const state = () => rewrite.state() || (page()?.writing ? 'busy' : '')
	const writing = () => state() === 'busy'
	return html`
		<aside class="side recap" aria-label="Recap">
			<${Panes}
				title="Recap"
				head=${html`<${PageTabs} id=${id} />`}
				actions=${html`<button
					type="button"
					class="ghost small"
					aria-label=${() => (writing() ? 'Writing the recap' : 'Write it now')}
					title=${() => (writing() ? 'Writing…' : 'Write the recap now')}
					disabled=${writing}
					aria-busy=${() => writing()}
					onClick=${(_event) => rewrite()}
				>
					<${Busy} state=${state}><${Icon} name="again" /><//>
				</button>`}
				onClose=${(_event) => openSide(id, null)}
			>
				<${Show}
					when=${() => page()?.page}
					fallback=${html`<p class="mute">
						${() =>
							!page()
								? 'Reading…'
								: page().writing
									? 'Writing the recap…'
									: 'No recap yet. It is written after the next answer, or now with ↻.'}
					</p>`}
				>
					<${Page} text=${() => page().page} thread=${id} />
				<//>
				<${Show} when=${() => page()?.writtenAt}>
					<p class="mute">
						<small
							>${() =>
								`From messages 0 to ${page().through - 1}, ${new Date(page().writtenAt).toLocaleString()}`}</small
						>
					</p>
				<//>
			<//>
		</aside>
	`
}

/** A page's lines as topics: done or open, what it says, the messages behind it */
export const topicsOf = (page) =>
	page
		.split('\n')
		.map((line) => line.match(/^- \[([ x])\] (.*)$/))
		.filter(Boolean)
		.map(([, mark, text]) => ({
			done: mark === 'x',
			text: text
				.replace(/\[#\d+\]\(#message-\d+\)/g, '')
				.replace(/[\s,;]+$/, '')
				.trim(),
			at: [...text.matchAll(/\[#\d+\]\(#message-(\d+)\)/g)].map((link) => link[1]),
		}))

/** The checklist; a link to a message scrolls the thread beside it there, one to a thread opens it */
const Page = (props) => html`
	<ul
		class="rows"
		onClick=${(event) => {
			const link = event.target.closest('a')
			if (link?.dataset.thread) return followThread(event, Number(link.dataset.thread))
			const at = link?.getAttribute('href')?.match(/^#message-(\d+)$/)?.[1]
			if (!at) return
			event.preventDefault()
			// Messages count from the thread's first, so the thread brings all of them before one is found
			loadEarlier(props.thread, true).then(() =>
				requestAnimationFrame(() => {
					const rows = document.querySelectorAll(
						`.thread[data-thread="${props.thread}"] li[data-message]`,
					)
					const row = [...rows].find((row) => row.getAttribute('data-message') === at)
					if (row) reveal(row)
				}),
			)
		}}
	>
		<${For} each=${() => topicsOf(props.text)}>${(topic) => html`<${Topic} topic=${topic} />`}<//>
	</ul>
`

/** A topic's row: the check when done, else a dot that works while a thread it names does */
function Topic(props) {
	const said = inline(props.topic.text, links)
	const working = () =>
		[...said.matchAll(/data-thread="(\d+)"/g)].some(
			(link) => threadOf(Number(link[1]))?.status === 'working',
		)
	return html`
		<li class=${() => ({ mute: props.topic.done && !working() })}>
			<${Show}
				when=${() => props.topic.done && !working()}
				fallback=${html`<${Dot} state=${() => (working() ? 'working' : '')} />`}
			>
				<${Icon} name="check" />
			<//>
			<div>
				<${Text} html=${said} />
				<small
					>${props.topic.at.map((at) => [' ', html`<a href=${`#message-${at}`}>#${at}</a>`])}</small
				>
			</div>
		</li>
	`
}

const Text = (props) => html`<span innerHTML=${props.html} />`
