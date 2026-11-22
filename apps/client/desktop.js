/**
 * Right-click menus in arbe desktop (apps/desktop): the system's own menu, whose items run the page's own actions. In a
 * browser there's no `window.mygo`, so the right-click stays the browser's.
 */
import { createRoot, createSignal } from 'solid-js'
import { report } from './notice.js'

const mygo = /** @type {any} */ (window).mygo
if (mygo) document.documentElement.dataset.desktop = ''

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
