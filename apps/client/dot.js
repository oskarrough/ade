/** One dot everywhere: on, working or blocked, or a thread's unread answer, `done` or `error`; and a switch, a row
 * whose dot says on or off */
import html from '@solidjs/html'
import { createSignal, flush } from 'solid-js'
import { report } from './notice.js'

export const Dot = (props) => html`
	<span
		title=${() => props.title}
		class=${() => [
			'dot',
			['on', 'working', 'blocked', 'done', 'error'].includes(props.state) ? props.state : '',
		]}
	></span>
`

/** A switch whose `onToggle` returns a promise flips at once and holds still until the server answers; if it says no,
 * it flips back and the notice says why */
export function Switch(props) {
	const [pending, setPending] = createSignal(/** @type {boolean | null} */ (null))
	const [waiting, setWaiting] = createSignal(false)
	const on = () => pending() ?? !!props.on
	let timer
	return html`
		<button
			type="button"
			class="row switch"
			role="switch"
			aria-checked=${() => String(on())}
			aria-busy=${() => (waiting() ? 'true' : undefined)}
			disabled=${() => props.disabled || waiting()}
			title=${() => props.title}
			onClick=${(event) => {
				if (waiting()) return
				const next = !on()
				// Shown now: an action's own writes would otherwise hold these back until it ends
				clearTimeout(timer)
				setPending(next)
				setWaiting(true)
				flush()
				const asked = props.onToggle(next, event)
				if (!asked?.then) {
					setWaiting(false)
					setPending(null)
					return
				}
				asked.then(
					// Held a moment more, till the list catches up, so it doesn't flick back first
					() => {
						setWaiting(false)
						timer = setTimeout(() => setPending(null), 2000)
					},
					(error) => {
						setWaiting(false)
						setPending(null)
						report(error)
					},
				)
			}}
		>
			<${Dot} state=${() => (on() ? 'on' : '')} />
			${() => props.children}
		</button>
	`
}
