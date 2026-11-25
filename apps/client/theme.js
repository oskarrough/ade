/**
 * Theme: Auto follows the system (how the page always worked, in `light-dark()` and system colours like CanvasText);
 * Light and Dark pin it regardless. Chosen from Cmd-K's "Choose theme", a second step in the same list, applied at
 * once, kept per device in localStorage — nothing asks the server, so it's the same choice in arbe desktop's webview
 * as in a browser tab.
 */
import { createEffect, createRoot, createSignal } from 'solid-js'

const KEY = 'ade.theme'
/** The three choices Cmd-K's "Choose theme" step offers, and their labels */
export const THEMES = ['auto', 'light', 'dark']
export const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' }
const META_COLOR = { light: '#ffffff', dark: '#121212' }

const read = () => {
	const value = localStorage.getItem(KEY)
	return THEMES.includes(value) ? value : 'auto'
}
/** The device's pinned theme, or 'auto' for the system's own */
const [theme, setTheme] = createSignal(read())
export { theme }

export const chooseTheme = (value) => {
	setTheme(value)
	try {
		if (value === 'auto') localStorage.removeItem(KEY)
		else localStorage.setItem(KEY, value)
	} catch {}
}

// Pins color-scheme away from the system's, which every `light-dark()` and system colour reads; auto clears it, back
// to the `color-scheme: light dark` the page always had. Runs at import, so a pinned choice applies before Jump ever
// opens. Owned by its own root, since it lives for the page's whole life and nothing ever disposes it.
createRoot(() => {
	createEffect(theme, (value) => {
		document.documentElement.dataset.theme = value === 'auto' ? '' : value
		// The address bar / status bar colour on a phone: the two media-matched metas are the system's own; a pinned
		// choice adds one more, with no media, that outranks them.
		const existing = /** @type {HTMLMetaElement | null} */ (
			document.querySelector('meta[name="theme-color"][data-theme-override]')
		)
		if (value === 'auto') {
			existing?.remove()
			return
		}
		const override = existing ?? document.createElement('meta')
		if (!existing) {
			override.name = 'theme-color'
			override.dataset.themeOverride = ''
			document.head.append(override)
		}
		override.content = META_COLOR[value]
	})
})
