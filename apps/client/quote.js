/**
 * Selecting text in a message shows a small Quote button at the selection's end, placed by CSS anchor positioning on a
 * marker the selection itself carries, not measured. Clicking it sends the selection to appendQuote (composer.js) for the
 * thread the message belongs to. The button disappears when the selection collapses, moves outside a message list, or is
 * in the composer or elsewhere on the page; a touch screen never gets it, so it doesn't fight the native selection menu.
 */
import html from '@solidjs/html'
import { onCleanup } from 'solid-js'
import { appendQuote } from './composer.js'

const touch = () => matchMedia('(pointer: coarse)').matches

/** The `ul[aria-label="Messages"]` a node sits in, and the thread column that owns it, or neither */
const messageListOf = (node) => {
	const element = node.nodeType === 1 ? node : node.parentElement
	const list = element?.closest('ul[aria-label="Messages"]')
	const thread = list?.closest('article.thread[data-thread]')?.dataset.thread
	return list && thread !== undefined ? { list, thread: Number(thread) } : null
}

/** One button, always mounted (a popover starts closed on its own); open and closed track the selection, never torn down and rebuilt. */
export function QuoteButton() {
	let button, marker, thread
	const hide = () => {
		thread = null
		button?.togglePopover(false)
		marker?.remove()
	}
	const onSelectionChange = () => {
		if (touch()) return hide()
		const selection = document.getSelection()
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return hide()
		const range = selection.getRangeAt(0)
		const at = messageListOf(range.commonAncestorContainer)
		if (!at || !selection.toString().trim()) return hide()
		marker ??= Object.assign(document.createElement('span'), {
			className: 'quote-anchor',
			ariaHidden: 'true',
		})
		marker.remove()
		const end = range.cloneRange()
		end.collapse(false)
		end.insertNode(marker)
		thread = at.thread
		button?.togglePopover(true)
	}
	document.addEventListener('selectionchange', onSelectionChange)
	onCleanup(() => {
		document.removeEventListener('selectionchange', onSelectionChange)
		marker?.remove()
	})
	const quote = () => {
		const text = document.getSelection()?.toString() ?? ''
		const id = thread
		hide()
		document.getSelection()?.removeAllRanges()
		if (text.trim()) appendQuote(id, text)
	}
	return html`
		<button
			type="button"
			popover="manual"
			class="quote"
			ref=${(el) => (button = el)}
			onMouseDown=${(event) => event.preventDefault()}
			onClick=${quote}
		>
			Quote
		</button>
	`
}
