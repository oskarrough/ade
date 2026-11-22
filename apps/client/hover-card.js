/** A small card beside a row while the pointer rests on it, one for every kind of row. Only with a fine pointer and CSS anchor positioning; anywhere else there's no card. */
import html from '@solidjs/html'
import { createSignal, onSettled, Show } from 'solid-js'

/** Whether this device shows hover cards at all */
export const cards =
	matchMedia('(hover: hover) and (pointer: fine)').matches && CSS.supports('anchor-name: --x')

const OPEN_AFTER = 400
const CLOSE_AFTER = 150
let made = 0
/** Until when the next card opens at once, as the pointer runs down a list from one open card to the next */
let warm = 0

/**
 * Put it inside the row it describes: the row becomes its anchor, and since the card is the row's own child, the pointer
 * moving onto it still counts as on the row. `content` is built only while it's open.
 */
export function HoverCard(props) {
	if (!cards) return null
	const name = `--hover-card-${++made}`
	const [open, setOpen] = createSignal(false)
	let card
	let timer
	const later = (next, wait) => {
		clearTimeout(timer)
		timer = setTimeout(() => {
			setOpen(next)
			if (!card?.isConnected) return
			if (next) {
				card.showPopover()
				warm = Infinity
			} else if (card.matches(':popover-open')) {
				card.hidePopover()
				warm = Date.now() + 500
			}
		}, wait)
	}
	onSettled(() => {
		const row = card.parentElement
		row.style.anchorName = name
		const enter = () => later(true, open() || Date.now() < warm ? 0 : OPEN_AFTER)
		const leave = () => later(false, CLOSE_AFTER)
		const away = (event) => {
			if (!card.contains(event.target)) later(false, 0)
		}
		row.addEventListener('pointerenter', enter)
		row.addEventListener('pointerleave', leave)
		row.addEventListener('pointerdown', away)
		return () => {
			clearTimeout(timer)
			row.removeEventListener('pointerenter', enter)
			row.removeEventListener('pointerleave', leave)
			row.removeEventListener('pointerdown', away)
		}
	})
	return html`<div
		class=${() => ['popover', 'hover-card', props.class]}
		popover="manual"
		style=${`position-anchor: ${name}`}
		ref=${(el) => {
			card = el
		}}
	>
		<${Show} when=${open}>${() => props.content}<//>
	</div>`
}
