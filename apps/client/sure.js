/** A button that asks by changing its words: the first press arms it, the second does it, and leaving lets it go. Both words sit in one cell, so it's as wide as the wider and arming moves nothing. */
import html from '@solidjs/html'
import { createSignal, Show } from 'solid-js'

export function Sure(props) {
	const [armed, setArmed] = createSignal(false)
	let timer
	const disarm = () => {
		clearTimeout(timer)
		setArmed(false)
	}
	return html`
		<span class=${() => ['sure', { armed: armed() }]}>
			<button
				type="button"
				class=${() => props.class}
				title=${() => props.title}
				disabled=${() => props.disabled}
				onBlur=${disarm}
				onClick=${(event) => {
					if (!props.ask || armed()) {
						disarm()
						return props.onConfirm(event)
					}
					setArmed(true)
					timer = setTimeout(disarm, 5000)
				}}
			>
				<span aria-hidden=${() => armed()}>${props.children}</span>
				<span aria-hidden=${() => !armed()}>${() => props.ask}</span>
			</button>
			<${Show} when=${() => armed() && props.why}><small>${() => props.why}</small><//>
		</span>
	`
}
