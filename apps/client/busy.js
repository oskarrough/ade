/**
 * A button that waits on the server says so: pressed, its words or icon give way to a turning ↻ at once, for half a
 * second at least so a quick answer still shows; done, a check for a moment; failed, the error goes to `onError`,
 * `report` unless the caller shows it itself. `busy(action)` gives the press to call and its `state`; `Busy` goes
 * inside the button around what it says, and keeps it as wide as before.
 */
import html from '@solidjs/html'
import { createSignal } from 'solid-js'
import { Icon } from './icons.js'
import { report } from './notice.js'

const LEAST = 500
const CHECKED = 1200

/** `action`, wrapped to show its progress in `state`: '' idle, 'busy' waiting, 'done' just finished */
export function busy(action, { onError = report } = {}) {
	const [state, setState] = createSignal('')
	let timer
	const press = async (...args) => {
		if (state() === 'busy') return
		clearTimeout(timer)
		setState('busy')
		const least = new Promise((resolve) => setTimeout(resolve, LEAST))
		try {
			await Promise.all([action(...args), least])
			setState('done')
			timer = setTimeout(() => setState(''), CHECKED)
		} catch (error) {
			await least
			setState('')
			onError(error)
		}
	}
	return Object.assign(press, { state })
}

/** What a button says, and over it while it waits or has just finished, ↻ turning or a check */
export const Busy = (props) =>
	html`<span class="busy" data-state=${() => props.state || undefined}>
		<span>${props.children}</span>
		<${Icon} name=${() => (props.state === 'done' ? 'check' : 'again')} />
	</span>`
