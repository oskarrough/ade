/**
 * Search: a field in the sidebar, and its results in the threads' place, the way the inbox opens. Every thread's
 * messages, archived ones included, best match first; each row shows its thread, who wrote it and when, and the words
 * around the match, and opens the thread scrolled to that message, lit as a recap link lights it.
 */
import html from '@solidjs/html'
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	latest,
	Loading,
	Show,
	untrack,
} from 'solid-js'
import {
	api,
	besideKey,
	colorOf,
	current,
	drawer,
	hrefOf,
	loadEarlier,
	openBeside,
	openSearch,
	openThread,
	page,
} from './server.js'
import { authorLabel } from './agent.js'
import { Stamp } from './time.js'
import { Icon } from './icons.js'
import { reveal } from './thread.js'

const searchQuery = () => (page().kind === 'search' ? page().query : null)

/** The sidebar's field: results follow each letter you type, Enter shows them on a phone, Escape or emptying it closes them */
export function SearchField() {
	const [draft, setDraft] = createSignal(untrack(searchQuery) ?? '')
	// Closed from anywhere else, it empties
	createEffect(searchQuery, (text) => {
		if (text === null) setDraft('')
	})
	const close = () => {
		setDraft('')
		if (latest(searchQuery) !== null) openThread(current())
	}
	const typed = (text) => {
		setDraft(text)
		if (text.trim()) openSearch(text)
		else close()
	}
	return html`
		<li class=${() => ['new', 'search', { current: searchQuery() !== null }]}>
			<form
				class="row"
				role="search"
				onSubmit=${(event) => {
					event.preventDefault()
					drawer(null)
				}}
			>
				<span class="plus" aria-hidden="true"><${Icon} name="search" /></span>
				<input
					type="search"
					class="bare"
					aria-label="Search messages"
					placeholder="Search"
					enterkeyhint="search"
					autocomplete="off"
					spellcheck="false"
					value=${() => draft()}
					onInput=${(event) => typed(event.currentTarget.value)}
					onKeyDown=${(event) => {
						if (event.key === 'Escape') close()
					}}
				/>
			</form>
		</li>
	`
}

/** The results, in the threads' place */
export function Search() {
	const results = createMemo(() => {
		const text = searchQuery()
		return text ? api(`/api/search?q=${encodeURIComponent(text)}`) : []
	})
	return html`
		<article class="thread current inbox search" aria-label="Search">
			<header>
				<h2 class="title">
					<button
						type="button"
						class="ghost thread-name"
						title="Every thread's messages, best match first"
					>
						<span>${() => `Search: ${searchQuery() ?? ''}`}</span>
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
				<${Loading} fallback=${html`<li class="mute">Searching…</li>`}>
					<${For} each=${results} keyed=${(item) => item.message}>
						${(item) => html`<${Result} item=${() => item()} />`}
					<//>
					<${Show} when=${() => !results().length}>
						<li class="mute">Nothing matches</li>
					<//>
				<//>
			</ul>
		</article>
	`
}

/** One match: its thread, who wrote it and when, then the words around it with the match tinted */
function Result(props) {
	const open = (event) => {
		if (event.shiftKey || event.altKey) return
		event.preventDefault()
		if (besideKey(event)) openBeside(props.item.thread)
		else showMessage(props.item.thread, props.item.message)
	}
	return html`
		<li class="question result" data-thread=${() => props.item.thread}>
			<small>
				<a class="thread-link" href=${() => hrefOf(props.item.thread)} onClick=${open}
					>${() => props.item.title}</a
				>
				${() => (props.item.archived ? ', archived' : '')} ${', '}<span
					title=${() => props.item.author}
					style=${() => colorOf(props.item.author)}
					>${() => authorLabel(props.item.author)}</span
				>
				${', '}<${Stamp}
					time=${() => (props.item.createdAt ? Date.parse(props.item.createdAt) : undefined)}
				/>
			</small>
			<a class="snippet" href=${() => hrefOf(props.item.thread)} onClick=${open}
				>${() => marked(props.item.snippet)}</a
			>
		</li>
	`
}

/** The server marks each matched word between \u0001 and \u0002 */
export const marked = (snippet) =>
	snippet.split('\u0001').flatMap((piece, index) => {
		if (!index) return [piece]
		const [match, ...after] = piece.split('\u0002')
		return [html`<mark>${match}</mark>`, after.join('')]
	})

/** Opens a thread on one message, by its entry id: once its newest page is on screen, the rest if it's further back */
export function showMessage(thread, message) {
	openThread(thread)
	const within = `.thread[data-thread="${thread}"]`
	let all = false
	let frames = 0
	const look = () => {
		const row = document.querySelector(`${within} li[data-entry="${message}"]`)
		// A thread just opened is still laying out: straight there, where smooth scrolling would be cut short
		if (row) return reveal(row, 'instant')
		if (!all && document.querySelector(`${within} li[data-entry]`)) {
			all = true
			return loadEarlier(thread, true).then(() => requestAnimationFrame(look))
		}
		if (++frames < 600) requestAnimationFrame(look)
	}
	requestAnimationFrame(look)
}
