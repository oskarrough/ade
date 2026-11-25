/**
 * Selecting text in a message shows a small Quote button just above where the pointer let go, or, for a selection made
 * by keyboard, at its focus end (the end that moved). CSS anchor positioning tethers it to a marker the selection
 * carries at that end, nudged to the pointer and kept inside the thread column, so it scrolls with the text. Clicking it sends the selection to appendQuote (composer.js) for the
 * thread the message belongs to. The button disappears when the selection collapses, moves outside a message list, or is
 * in the composer or elsewhere on the page; a touch screen never gets it, so it doesn't fight the native selection menu.
 */
import html from '@solidjs/html'
import { onSettled } from 'solid-js'
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
	/** Where the mouse is while it drags, then where it let go; a keypress forgets it, so a keyboard selection uses its focus end */
	let pointer = null
	let pressed = false
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
		marker.style.left = marker.style.top = ''
		const end = document.createRange()
		end.setStart(selection.focusNode, selection.focusOffset)
		end.insertNode(marker)
		thread = at.thread
		button?.togglePopover(true)
		const column = at.list.closest('article.thread')?.getBoundingClientRect()
		if (!button || !column) return
		const from = marker.getBoundingClientRect()
		const half = button.offsetWidth / 2
		const clamp = (value, low, high) => Math.min(Math.max(value, low), Math.max(low, high))
		const x = clamp(pointer?.x ?? from.left, column.left + half, column.right - half)
		const y = clamp(pointer?.y ?? from.top, column.top, column.bottom)
		marker.style.left = `${x - from.left}px`
		marker.style.top = `${y - from.top}px`
	}
	const onPointerDown = (event) => {
		pressed = event.pointerType !== 'touch' && event.button === 0
		pointer = pressed ? { x: event.clientX, y: event.clientY } : null
	}
	const onPointerMove = (event) => {
		if (pressed) pointer = { x: event.clientX, y: event.clientY }
	}
	const onPointerUp = (event) => {
		if (!pressed) return
		pressed = false
		pointer = { x: event.clientX, y: event.clientY }
		onSelectionChange()
	}
	const onKeyDown = () => {
		pointer = null
	}
	onSettled(() => {
		document.addEventListener('selectionchange', onSelectionChange)
		document.addEventListener('pointerdown', onPointerDown)
		document.addEventListener('pointermove', onPointerMove)
		document.addEventListener('pointerup', onPointerUp)
		document.addEventListener('keydown', onKeyDown)
		return () => {
			document.removeEventListener('selectionchange', onSelectionChange)
			document.removeEventListener('pointerdown', onPointerDown)
			document.removeEventListener('pointermove', onPointerMove)
			document.removeEventListener('pointerup', onPointerUp)
			document.removeEventListener('keydown', onKeyDown)
			marker?.remove()
		}
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
