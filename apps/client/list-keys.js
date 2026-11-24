import { createEffect, onSettled } from 'solid-js'

let made = 0

/**
 * The keys of a list you type above: Cmd-K, the @ and / list and the model picker. Its rows are the list's enabled
 * `[role=option]`s, whoever renders them. The first is highlighted when the list opens and when `fresh` changes; a row
 * that stays when the list changes stays highlighted. The arrows move and wrap, Enter (and Tab, with `tab`) clicks the
 * row with the key's modifiers, Escape calls `escape`. The row scrolls into view, and the field names it in
 * aria-activedescendant. Returns the field's keydown, true when it took the key, and `highlighted()`, the row.
 * @param {{ field: () => HTMLElement, list: () => HTMLElement, fresh?: () => unknown, tab?: boolean, escape?: () => void }} keys
 */
export function listKeys({ field, list, fresh, tab, escape }) {
	let row
	const rows = () => [...(list()?.querySelectorAll('[role=option]:not(:disabled)') ?? [])]
	const highlight = (next) => {
		if (next === row) return
		row?.setAttribute('aria-selected', 'false')
		row = next
		if (!row) return field()?.removeAttribute('aria-activedescendant')
		row.id ||= `option-${++made}`
		row.setAttribute('aria-selected', 'true')
		row.scrollIntoView({ block: 'nearest' })
		field().setAttribute('aria-activedescendant', row.id)
	}
	const first = () => highlight(rows()[0])
	if (fresh) createEffect(fresh, first)
	onSettled(() => {
		list().id ||= `list-${++made}`
		field().setAttribute('aria-controls', list().id)
		const observer = new MutationObserver(() => {
			const all = rows()
			highlight(all.includes(row) ? row : all[0])
		})
		observer.observe(list(), { childList: true, subtree: true })
		const popover = list().closest('[popover]')
		const opened = (event) => event.newState === 'open' && first()
		popover?.addEventListener('toggle', opened)
		first()
		return () => {
			observer.disconnect()
			popover?.removeEventListener('toggle', opened)
		}
	})
	const keydown = (event) => {
		if (event.isComposing) return false
		const all = rows()
		const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
		const at = all.indexOf(row)
		if (step && all.length)
			highlight(all.at(at < 0 ? (step > 0 ? 0 : -1) : (at + step) % all.length))
		else if ((event.key === 'Enter' || (tab && event.key === 'Tab')) && at >= 0)
			row.dispatchEvent(new MouseEvent('click', event))
		else if (event.key === 'Escape' && escape) escape()
		else return false
		event.preventDefault()
		return true
	}
	return { keydown, highlighted: () => row }
}
