/**
 * Theme: Auto follows the system (how the page always worked, in `light-dark()` and system colours like CanvasText);
 * Light and Dark pin it regardless. Chosen from Cmd-K's "Choose theme", applied at once, kept per device in
 * localStorage — nothing asks the server, so it's the same choice in arbe desktop's webview as in a browser tab.
 */
import html from '@solidjs/html'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { Icon } from './icons.js'
import { placePopover } from './popover.js'

const KEY = 'ade.theme'
const THEMES = ['auto', 'light', 'dark']
const LABEL = { auto: 'Auto', light: 'Light', dark: 'Dark' }
const META_COLOR = { light: '#ffffff', dark: '#121212' }

const read = () => {
	const value = localStorage.getItem(KEY)
	return THEMES.includes(value) ? value : 'auto'
}
/** The device's pinned theme, or 'auto' for the system's own */
export const [theme, setTheme] = createSignal(read())

export const chooseTheme = (value) => {
	setTheme(value)
	try {
		if (value === 'auto') localStorage.removeItem(KEY)
		else localStorage.setItem(KEY, value)
	} catch {}
}

// Pins color-scheme away from the system's, which every `light-dark()` and system colour reads; auto clears it, back
// to the `color-scheme: light dark` the page always had. Runs at import, so a pinned choice applies before Jump ever
// opens.
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

const [asked, setAsked] = createSignal(false)
/** Opens the theme menu, from Cmd-K's "Choose theme" */
export const openThemeMenu = () => setAsked(true)

/** The theme menu: a small popover, centred, with the three choices and a check on the one that's on */
export function ThemeMenu() {
	let panel
	createEffect(asked, (wish) => {
		if (!wish) return
		setAsked(false)
		panel.showPopover()
	})
	return html`
		<div
			class="popover model-picker theme-menu"
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => event.newState === 'open' && placePopover(panel)}
		>
			<div class="model-controls">
				<ul class="model-list">
					<li role="presentation">
						<h3>Theme</h3>
						<div class="models" role="group" aria-label="Theme">
							<${For} each=${() => THEMES}
								>${(value) => html`
									<button
										type="button"
										class="ghost model"
										aria-pressed=${() => String(theme() === value)}
										onClick=${() => {
											chooseTheme(value)
											panel.hidePopover()
										}}
									>
										<span>${() => LABEL[value]}</span>
										<${Show} when=${() => theme() === value}><${Icon} name="check" /><//>
									</button>
								`}
							<//>
						</div>
					</li>
				</ul>
			</div>
		</div>
	`
}
