import html from '@solidjs/html'
import { onCleanup } from 'solid-js'

/** Popovers sit above their button on desktop (below, when only there they fit), its left edge on the button's, or its right edge when `end` says so or it wouldn't fit; one with no button sits centred near the top. On phones they become bottom sheets, unless `sheet` is false. */
export function placePopover(panel, button, sheet = true, end = false) {
	if (sheet && matchMedia('(max-width: 700px)').matches) return panel.removeAttribute('style')
	if (!button)
		return Object.assign(panel.style, {
			transformOrigin: 'top',
			left: `${Math.max(8, (innerWidth - panel.offsetWidth) / 2)}px`,
			top: `${Math.round(innerHeight * 0.15)}px`,
			bottom: 'auto',
		})
	const rect = button.getBoundingClientRect()
	const below = rect.top < panel.offsetHeight + 14 && innerHeight - rect.bottom > rect.top
	const fits = !end && rect.left + panel.offsetWidth <= innerWidth - 8
	Object.assign(panel.style, {
		transformOrigin: `${fits ? 'left' : 'right'} ${below ? 'top' : 'bottom'}`,
		left: `${Math.max(8, fits ? rect.left : rect.right - panel.offsetWidth)}px`,
		top: below ? `${rect.bottom + 6}px` : 'auto',
		bottom: below ? 'auto' : `${innerHeight - rect.top + 6}px`,
	})
}

/**
 * A button and the popover it opens. The popover sits by `anchor` (the button unless given), and again whenever its size
 * changes; the button says whether it's open. Escape and a click outside close it, as any popover. `ref` hands over
 * the popover, `onToggle` its toggle event.
 */
export function Popover(props) {
	const button = props.button
	button.setAttribute('aria-expanded', 'false')
	let panel
	const place = () => placePopover(panel, props.anchor ?? button, true, props.end)
	const resized = new ResizeObserver(place)
	onCleanup(() => resized.disconnect())
	return html`${button}
		<div
			class=${() => ['popover', props.class]}
			popover
			ref=${(el) => {
				panel = el
				button.popoverTargetElement = el
				props.ref?.(el)
			}}
			onClick=${(event) => props.onClick?.(event)}
			onToggle=${(event) => {
				const open = event.newState === 'open'
				button.setAttribute('aria-expanded', String(open))
				if (open) {
					place()
					resized.observe(panel)
				} else resized.disconnect()
				props.onToggle?.(event)
			}}
		>
			${props.children}
		</div>`
}
