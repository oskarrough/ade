/** A value edited where it's shown. Enter or clicking away saves it with `onSave`, Escape puts the old one back, and both leave the field and call `onDone`. A save that throws puts the old value back too, and the field says why. `focused` opens it with its text selected. */
import html from '@solidjs/html'
import { createSignal, omit } from 'solid-js'

export function EditInPlace(props) {
	const [error, setError] = createSignal('')
	let undo = false
	const leave = async (field) => {
		const next = field.value.trim()
		if (undo || next === props.value) {
			undo = false
			field.value = props.value
			return props.onDone?.()
		}
		setError('')
		try {
			await props.onSave(next)
			props.onDone?.()
		} catch (failure) {
			setError(failure.message)
			field.value = props.value
			// After Enter, focus comes back to try again; after a click elsewhere it stays there
			if (document.activeElement === document.body) field.focus()
		}
	}
	return html`<input
		...${omit(props, 'value', 'onSave', 'onDone', 'focused', 'class', 'title')}
		class=${() => [props.class, { bad: !!error() }]}
		title=${() => error() || props.title}
		value=${() => props.value}
		ref=${(field) =>
			props.focused &&
			requestAnimationFrame(() => {
				field.focus()
				field.select()
			})}
		onBlur=${(event) => leave(event.currentTarget)}
		onKeyDown=${(event) => {
			if (event.key !== 'Enter' && event.key !== 'Escape') return
			undo = event.key === 'Escape'
			event.preventDefault()
			event.currentTarget.blur()
		}}
	/>`
}
