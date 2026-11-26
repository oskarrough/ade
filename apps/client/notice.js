/** What went wrong, above the active composer's input, or above the inbox's answer box it came from; goes by itself. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { keyless } from './server.js'
import { createEffect, createSignal, Show } from 'solid-js'

const [notice, setNotice] = createSignal(
	/** @type {{text: string, from?: symbol}} */ ({ text: '' }),
	{ equals: false },
)
/** `from` is the Notice that shows it, when one place shouldn't show another's, like one inbox answer among several */
export const report = (error, /** @type {symbol} */ from = undefined) => {
	setNotice({ text: error?.message ?? String(error), from })
}

export function Notice(props) {
	const text = () => (notice().from === props.from ? notice().text : '')
	createEffect(text, (text) => {
		// Bringing the device in takes another one, so that notice waits to be dismissed
		if (!text || text === keyless) return
		const timer = setTimeout(() => setNotice({ text: '' }), 6000)
		return () => clearTimeout(timer)
	})
	return html`
		<${Show} when=${text}>
			<p class="notice" role="alert">
				<span>${text}</span>
				<button
					type="button"
					class="ghost small"
					aria-label="Dismiss"
					onClick=${(_e) => setNotice({ text: '' })}
				>
					<${Icon} name="close" />
				</button>
			</p>
		<//>
	`
}
