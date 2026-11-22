/**
 * Right-click menus in arbe desktop (apps/desktop): the system's own menu, whose items run the page's own actions. In a
 * browser there's no `window.mygo`, so the right-click stays the browser's.
 */
import { createRoot, createSignal } from 'solid-js'
import { report } from './notice.js'

const mygo = /** @type {any} */ (window).mygo
if (mygo) {
	document.documentElement.dataset.desktop = ''
	clearOfControls()
}

/**
 * The window's own buttons sit over the top right of the page. Whichever pane reaches under them, the last one or, once
 * the panes scroll sideways, the one at the window's edge, gets `--under-controls`: how far it reaches in, which its
 * header keeps clear of.
 */
function clearOfControls() {
	let queued = false
	const measure = () => {
		queued = false
		const root = document.documentElement
		const inset =
			Number.parseFloat(getComputedStyle(root).getPropertyValue('--mygo-titlebar-inset-right')) || 0
		const edge = root.clientWidth - inset
		const panes = /** @type {NodeListOf<HTMLElement>} */ (
			document.querySelectorAll('.threads > :is(.thread, .side)')
		)
		for (const pane of panes) {
			const { left, right } = pane.getBoundingClientRect()
			const under = Math.min(Math.max(right - edge, 0), right - left)
			pane.style.setProperty('--under-controls', `${Math.round(under)}px`)
		}
	}
	const queue = () => {
		if (queued) return
		queued = true
		requestAnimationFrame(measure)
	}
	// Panes open, close and get dragged wider; the window resizes, goes full screen and scrolls the panes sideways
	const sizes = new ResizeObserver(queue)
	const panesChanged = (record) =>
		record.target.matches?.('.threads') ||
		[...record.addedNodes].some(
			(node) => node.matches?.('.threads') || node.querySelector?.('.threads'),
		)
	new MutationObserver((records) => {
		if (!records.some(panesChanged)) return
		for (const pane of document.querySelectorAll('.threads > :is(.thread, .side)'))
			sizes.observe(pane)
		queue()
	}).observe(document, { childList: true, subtree: true })
	addEventListener('resize', queue)
	addEventListener('scroll', queue, true)
	mygo.on('mygo:title-bar', queue)
}

/**
 * Shows `items`, `{label, run}`, `null` for a separator, or `false`/`undefined` (omitted), as the window's menu at the
 * pointer, and runs the one picked. Does nothing outside the desktop window, nor over a selection or a field, whose
 * menu is the webview's (Copy, Paste).
 */
export function nativeMenu(event, items) {
	if (!mygo || event.target.closest?.('input, textarea, [contenteditable]')) return
	// No separator first, last or twice
	const shown = []
	for (const item of items) {
		if (item === false || item === undefined) continue
		if (item === null) {
			if (shown.length && shown.at(-1) !== null) shown.push(null)
			continue
		}
		shown.push(item)
	}
	if (shown.at(-1) === null) shown.pop()
	if (!shown.length) return
	event.preventDefault()
	mygo
		.call(
			'Desktop.Menu',
			shown.map((item) => item?.label ?? ''),
		)
		.then((picked) => (picked >= 0 ? shown[picked].run() : undefined))
		.catch(report)
}

/** The text selected inside `element`, if any */
export const selectedIn = (element) => {
	const selection = document.getSelection()
	return selection && !selection.isCollapsed && element.contains(selection.anchorNode)
		? selection.toString()
		: ''
}

export const copyText = (text) => navigator.clipboard.writeText(text)

/** The desktop app's version, asked once; empty in a browser, or in an app too old to say */
export const [desktopVersion] = createRoot(() => {
	const [version, setVersion] = createSignal('')
	mygo?.call('Desktop.Version').then(setVersion, () => {})
	return [version]
})
