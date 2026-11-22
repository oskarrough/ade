/** A small card beside a row while the pointer rests on it, one for every kind of row. Only with a fine pointer and CSS anchor positioning; anywhere else there's no card. */
import html from '@solidjs/html'
import { createSignal, flush, onSettled, Show } from 'solid-js'

/** Whether this device shows hover cards at all */
export const cards =
	matchMedia('(hover: hover) and (pointer: fine)').matches && CSS.supports('anchor-name: --x')

const OPEN_AFTER = 400
const CLOSE_AFTER = 150
const GLIDE = 150
let made = 0

/** The row the one card shows, `{name, class, content}`, or null */
const [shown, setShown] = createSignal(/** @type {any} */ (null))
let frame
let timer
const later = (next, wait) => {
	clearTimeout(timer)
	timer = setTimeout(() => show(next), wait)
}

/** Shows another row's card in the same frame: its content swaps at once, the frame glides from where it was to where it lands */
function show(next) {
	if (!frame?.isConnected || shown() === next) return
	const open = frame.matches(':popover-open')
	if (!next) {
		if (open) frame.hidePopover()
		return setShown(null)
	}
	const from = open && frame.getBoundingClientRect()
	frame.getAnimations().forEach((animation) => animation.cancel())
	setShown(next)
	flush()
	frame.style.positionAnchor = next.name
	frame.style.inset = ''
	if (!open) frame.showPopover()
	beside(next.element)
	if (!open) return
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
	const to = frame.getBoundingClientRect()
	frame.animate(
		[
			{
				translate: `${from.left - to.left}px ${from.top - to.top}px`,
				width: `${from.width}px`,
				height: `${from.height}px`,
				overflow: 'hidden',
			},
			{ translate: '0 0', width: `${to.width}px`, height: `${to.height}px`, overflow: 'hidden' },
		],
		{ duration: GLIDE, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' },
	)
}

/** Where the anchor didn't take, as in a list that scrolls on its own in some browsers, the card goes beside its row by hand */
function beside(row) {
	const card = frame.getBoundingClientRect()
	const at = row.getBoundingClientRect()
	if (card.bottom > at.top && card.top < at.bottom) return
	const left = at.right + card.width + 16 <= innerWidth ? at.right : at.left - card.width - 16
	const top = Math.max(8, Math.min(at.top, innerHeight - 8 - card.height))
	frame.style.inset = `${top}px auto auto ${Math.max(8, left)}px`
}

/** The one card frame every row's card opens in; mounted once, where the rows are */
export function HoverFrame() {
	if (!cards) return null
	return html`<div
		class=${() => ['popover', 'hover-card', shown()?.class]}
		popover="manual"
		ref=${(el) => {
			frame = el
		}}
		onPointerEnter=${() => clearTimeout(timer)}
		onPointerLeave=${() => later(null, CLOSE_AFTER)}
	>
		<${Show} when=${shown} keyed=${true}>${(row) => row.content}<//>
	</div>`
}

/**
 * Put it inside the row it describes: the row becomes the frame's anchor while the pointer is on it. `content` is
 * built only while it's shown; the pointer may cross onto the card without closing it.
 */
export function HoverCard(props) {
	if (!cards) return null
	const row = {
		element: /** @type {any} */ (null),
		name: `--hover-card-${++made}`,
		get class() {
			return props.class
		},
		get content() {
			return props.content
		},
	}
	let marker
	onSettled(() => {
		const element = marker.parentElement
		row.element = element
		element.style.anchorName = row.name
		const enter = () => later(row, shown() ? 0 : OPEN_AFTER)
		const leave = () => later(null, CLOSE_AFTER)
		const away = () => later(null, 0)
		element.addEventListener('pointerenter', enter)
		element.addEventListener('pointerleave', leave)
		element.addEventListener('pointerdown', away)
		return () => {
			element.removeEventListener('pointerenter', enter)
			element.removeEventListener('pointerleave', leave)
			element.removeEventListener('pointerdown', away)
			if (shown() === row) later(null, 0)
		}
	})
	return html`<span
		hidden
		ref=${(el) => {
			marker = el
		}}
	></span>`
}
