/**
 * The inbox: what needs you, in the threads' place. First every open question agents asked with `ask_person`, shared by
 * everyone on the server, newest first; then, in threads you wrote in, runs that failed and answers you haven't read, as
 * the sidebar's dots mark them, which opening the thread clears. A question shows its thread, who asked, when, the
 * thread's recap line, and the question as the thread shows it; you answer under it with the thread's own composer, open
 * the thread, or dismiss it until that thread asks again. A failure or an answer shows what was said; dismissing it marks
 * the thread read, for you alone.
 */
import html from '@solidjs/html'
import { createMemo, For, Loading, onSettled, refresh, Show, untrack } from 'solid-js'
import {
	api,
	colorOf,
	current,
	dismiss,
	followThread,
	hrefOf,
	inbox,
	openThread,
	server,
	threadOf,
	titleOf,
} from './server.js'
import { Body, Clamp, links } from './thread.js'
import { authorLabel } from './agent.js'
import { Composer } from './composer.js'
import { topicsOf } from './recap.js'
import { inline } from './markdown.js'
import { Notice, report } from './notice.js'
import { Stamp } from './time.js'
import { Icon } from './icons.js'
import { Dot } from './dot.js'

export function Inbox() {
	return html`
		<article class="thread current inbox" aria-label="Inbox">
			<header>
				<h2 class="title">
					<button
						type="button"
						class="ghost thread-name"
						title="What needs you: questions, failures, unread answers"
					>
						<span>${() => (inbox.length ? `Inbox ${inbox.length}` : 'Inbox')}</span>
					</button>
				</h2>
				<button
					type="button"
					class="close"
					title="Back to the thread"
					aria-label="Close"
					onClick=${() => openThread(current())}
				>
					<${Icon} name="close" />
				</button>
			</header>
			<ul>
				<li class="room"><${Notice} /></li>
				<${For} each=${() => inbox} keyed=${(item) => `${item.kind} ${item.thread}`}>
					${(item) =>
						item().question
							? html`<${Question} item=${() => item()} />`
							: html`<${Unread} item=${() => item()} />`}
				<//>
				<${Show} when=${() => !inbox.length}>
					<li class="mute">Nothing needs you</li>
				<//>
			</ul>
		</article>
	`
}

/** One question: its thread, who asked and when, the recap's line, the question, then your answer */
function Question(props) {
	const thread = untrack(() => props.item.thread)
	const data = () => props.item.question.data
	/** The agent that asked, by its conversation, as the thread list has it now */
	const asks = () =>
		threadOf(thread)?.agents.find((agent) => agent.conversation === props.item.asker)?.to
	return html`
		<li class="question" data-thread=${thread}>
			<small>
				<a
					class="thread-link"
					href=${hrefOf(thread)}
					onClick=${(event) => followThread(event, thread)}
					>${() => titleOf(thread)}</a
				>
				${', '}<span title=${() => data().author} style=${() => colorOf(data().author)}
					>${() => authorLabel(data().author)}</span
				>
				${', '}<${Stamp} time=${() => data().createdAt && Date.parse(data().createdAt)} />
			</small>
			<${Show} when=${() => server().modules.includes('recap')}>
				<${Loading}><${RecapLine} thread=${thread} /><//>
			<//>
			<${Body} data=${() => data()} />
			<${Composer} thread=${() => thread} inbox asks=${asks} />
			<div class="links">
				<a href=${hrefOf(thread)} onClick=${(event) => followThread(event, thread)}>Open thread</a>
				${', '}
				<button
					type="button"
					class="ghost small"
					title="Hide this question until the thread asks again"
					onClick=${() => dismiss(props.item).catch(report)}
				>
					Dismiss
				</button>
			</div>
		</li>
	`
}

/** A failed run or an answer you haven't read, in a thread you wrote in: its dot, thread, who, when, and what it said; opening the thread clears it */
function Unread(props) {
	const thread = untrack(() => props.item.thread)
	const data = () => props.item.message.data
	const failed = () => props.item.kind === 'failed'
	return html`
		<li class="question" data-thread=${thread}>
			<small>
				<${Dot} state=${() => (failed() ? 'error' : 'done')} />
				<a
					class="thread-link"
					href=${hrefOf(thread)}
					onClick=${(event) => followThread(event, thread)}
					>${() => titleOf(thread)}</a
				>
				${', '}<span title=${() => data().author} style=${() => colorOf(data().author)}
					>${() => authorLabel(data().author)}</span
				>${() => (failed() ? ' failed, ' : ' answered, ')}<${Stamp}
					time=${() => data().createdAt && Date.parse(data().createdAt)}
				/>
			</small>
			<${Clamp}><${Body} data=${() => data()} /><//>
			<div class="links">
				<a href=${hrefOf(thread)} onClick=${(event) => followThread(event, thread)}>Open thread</a>
				${', '}
				<button
					type="button"
					class="ghost small"
					title="Mark it read"
					onClick=${() => dismiss(props.item).catch(report)}
				>
					Dismiss
				</button>
			</div>
		</li>
	`
}

/** Where the thread stands, in one line: the recap's newest open topic, else its newest */
function RecapLine(props) {
	let writing = false
	// Asked with ?open, as the Recap tab asks: a page behind catches up, and comes again while it's written
	const page = createMemo(() =>
		api(`/api/threads/${props.thread}/recap?open`).then(
			(page) => ((writing = page.writing), page),
			() => ({ page: '' }),
		),
	)
	onSettled(() => {
		const timer = setInterval(() => writing && refresh(page), 3000)
		return () => clearInterval(timer)
	})
	const line = () => {
		const topics = topicsOf(page().page)
		return (topics.findLast((topic) => !topic.done) ?? topics.at(-1))?.text
	}
	return html`
		<${Show} when=${line}>
			<p class="mute recap-line" innerHTML=${() => inline(line(), links)}></p>
		<//>
	`
}
