/** One dot everywhere: on, working or blocked, or a thread's unread answer, `done` or `error`; and a switch, a row
 * whose dot says on or off */
import html from '@solidjs/html'

export const Dot = (props) => html`
	<span
		title=${() => props.title}
		class=${() => [
			'dot',
			{
				on: props.state === 'on',
				working: props.state === 'working',
				blocked: props.state === 'blocked',
				done: props.state === 'done',
				error: props.state === 'error',
			},
		]}
	></span>
`

export const Switch = (props) => html`
	<button
		type="button"
		class="row switch"
		role="switch"
		aria-checked=${() => String(!!props.on)}
		disabled=${() => props.disabled}
		title=${() => props.title}
		onClick=${(event) => props.onToggle(!props.on, event)}
	>
		<${Dot} state=${() => (props.on ? 'on' : '')} />
		${() => props.children}
	</button>
`
