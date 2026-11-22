/**
 * Jump: Cmd-K or Ctrl-K (and -O) opens one field over everything, the model picker's frame. Empty, it lists the threads
 * you opened last, then the actions; typed, the threads whose title has every word (archived ones too), the bots, the
 * actions, and with search on, the messages that match. The arrows walk the rows, Enter goes, Escape closes. On a phone
 * it's a sheet, opened from the bar's search button.
 */
import html from '@solidjs/html'
import { createEffect, createMemo, createSignal, For, onSettled, Show } from 'solid-js'
import {
	api,
	besideKey,
	bots,
	colorOf,
	current,
	drawer,
	waiting,
	openInbox,
	openBeside,
	openSearch,
	openThread,
	openUsage,
	server,
	threadOf,
	threadRows,
} from './server.js'
import { matches } from './model-picker.js'
import { Dot } from './dot.js'
import { Icon } from './icons.js'
import { placePopover } from './popover.js'
import { marked, showMessage } from './search.js'
import { setArchivedPage, setCreatingBot } from './thread-list.js'
import { openTaskForm } from './schedule.js'
import { openThemeMenu, theme, ThemeMenu } from './theme.js'

const RECENT = 'ade.recent'
const readRecent = () => {
	try {
		return JSON.parse(localStorage.getItem(RECENT) ?? '[]')
	} catch {
		return []
	}
}
/** The threads this browser opened, newest first */
const [recent, setRecent] = createSignal(readRecent())

let show
/** The phone bar's search button */
export const openJump = () => show?.()

/** A snippet from a little before its first match, so one line shows the match */
const nearMatch = (snippet) => {
	const at = snippet.indexOf('\u0001')
	if (at <= 24) return snippet
	const from = snippet.slice(at - 12)
	const space = from.indexOf(' ')
	return `…${space >= 0 && space < 12 ? from.slice(space + 1) : from}`
}
/** How well a name fits what's typed: 0 it is it, 1 it starts with it, 2 a word of it does, 3 it's somewhere */
const fit = (text, name) => {
	const typed = text.toLowerCase()
	const words = name.toLowerCase()
	if (words === typed) return 0
	if (words.startsWith(typed)) return 1
	return words.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(typed)) ? 2 : 3
}
/** Who wins a tie between sections: a bot, then an action, then threads; there are few of the first two, and their names are what you'd type */
const TIE = { Bots: 0.5, Actions: 0.25 }
const idOf = (key) => `jump-${key.replace(/[^\w-]+/g, '-')}`
/** An open popover that Jump opening would close: any but a manual one, like the @ list */
const OTHER_OPEN = '[popover]:not([popover="manual"], .jump):popover-open'
const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const phone = () => matchMedia('(max-width: 700px)').matches
const on = (module) => server().modules.includes(module)
/** One of the list foot's buttons, pressed; on a phone the list comes in first, since its popovers sit in it */
const press = (selector) => () => {
	if (phone()) drawer('list')
	document.querySelector(selector)?.click()
}

export function Jump() {
	let input, panel
	const [typed, setTyped] = createSignal('')
	const search = () => typed().trim()
	const [keyed, setKeyed] = createSignal(0)
	const [hits, setHits] = createSignal({ for: '', rows: [] })

	createEffect(current, (id) => {
		if (!id) return
		const next = [id, ...readRecent().filter((each) => each !== id)].slice(0, 30)
		setRecent(next)
		try {
			localStorage.setItem(RECENT, JSON.stringify(next))
		} catch {}
	})

	let timer
	createEffect(
		() => (on('search') ? search() : ''),
		(text) => {
			clearTimeout(timer)
			if (text.length < 3) {
				setHits({ for: '', rows: [] })
				return
			}
			timer = setTimeout(
				() =>
					api(`/api/search?q=${encodeURIComponent(text)}`).then(
						(rows) => search() === text && setHits({ for: text, rows: rows.slice(0, 6) }),
						() => {},
					),
				150,
			)
		},
	)

	const actions = () =>
		[
			{ label: 'New thread', run: () => openThread(null) },
			on('bots') && {
				label: 'New bot',
				run: () => {
					if (phone()) drawer('list')
					setArchivedPage(false)
					setCreatingBot(true)
				},
			},
			on('inbox') && {
				label: 'Inbox',
				note: waiting().length ? String(waiting().length) : '',
				run: openInbox,
			},
			{ label: 'Settings', run: press('.settings-toggle') },
			{ label: 'Runners', run: press('.runner-toggle') },
			on('schedule') && { label: 'Scheduled tasks', run: press('.schedule-toggle') },
			on('schedule') && {
				label: 'Schedule a task',
				run: () => openTaskForm(current() ?? undefined),
			},
			{
				label: 'Choose theme',
				note: { auto: 'Auto', light: 'Light', dark: 'Dark' }[theme()],
				run: openThemeMenu,
			},
			on('usage') && { label: 'Usage', run: openUsage },
		]
			.filter(Boolean)
			.map((action) => ({ ...action, key: `action ${action.label}` }))

	const threadOption = (row) => ({
		key: `thread ${row.id}`,
		label: row.title || `thread ${row.id}`,
		state: row.status,
		note: row.archived ? 'archived' : '',
		run: (event) => (besideKey(event) ? openBeside : openThread)(row.id),
	})

	/** Best first: the title starting with what's typed, then a word of it, then anywhere; open before archived; opened lately before the rest */
	const found = () => {
		const text = search()
		const homes = new Set(bots.map((bot) => bot.home))
		const seen = new Map(recent().map((id, at) => [id, at]))
		const { open, archived } = threadRows()
		return [...open, ...archived]
			.filter((row) => !homes.has(row.id) && matches(text, row.title ?? ''))
			.map((row) => ({
				row,
				rank: fit(text, row.title) * 2 + (row.archived ? 1 : 0),
				seen: seen.get(row.id) ?? Infinity,
			}))
			.sort((a, b) => a.rank - b.rank || a.seen - b.seen || b.row.id - a.row.id)
			.slice(0, 20)
			.map(({ row }) => ({ ...threadOption(row), fit: fit(text, row.title) }))
	}

	const sections = createMemo(() => {
		if (!search()) {
			const homes = new Set(bots.map((bot) => bot.home))
			const lately = recent()
				.filter((id) => id !== current() && !homes.has(id))
				.map(threadOf)
				.filter(Boolean)
			const rest = threadRows().open.filter(
				(row) => row.id !== current() && !homes.has(row.id) && !recent().includes(row.id),
			)
			return [
				{
					title: 'Recent',
					options: [...lately, ...rest].slice(0, 8).map(threadOption),
				},
				{ title: 'Actions', options: actions() },
			]
		}
		const text = search()
		const shown = hits().for === text ? hits().rows : []
		const best = (section) =>
			Math.min(...section.options.map((option) => option.fit ?? 4)) - (TIE[section.title] ?? 0)
		return [
			{ title: 'Threads', options: found() },
			{
				title: 'Bots',
				options: bots
					.filter((bot) => matches(text, bot.name))
					.map((bot) => ({
						key: `bot ${bot.name}`,
						label: bot.name,
						color: bot.name,
						state: threadOf(bot.home)?.status,
						note: 'bot',
						fit: fit(text, bot.name),
						run: (event) => (besideKey(event) ? openBeside : openThread)(bot.home),
					}))
					.sort((a, b) => a.fit - b.fit),
			},
			{
				title: 'Actions',
				options: actions()
					.filter((action) => matches(text, action.label))
					.map((action) => ({ ...action, fit: fit(text, action.label) }))
					.sort((a, b) => a.fit - b.fit),
			},
			{
				title: 'Messages',
				options: on('search')
					? [
							...shown.map((hit) => ({
								key: `message ${hit.message}`,
								label: marked(nearMatch(hit.snippet)),
								note: hit.title,
								run: () => showMessage(hit.thread, hit.message),
							})),
							...(text.length >= 3
								? [
										{
											key: 'search',
											label: `All messages with “${text}”`,
											run: () => openSearch(text),
										},
									]
								: []),
						]
					: [],
			},
		]
			.filter((section) => section.options.length)
			.sort((a, b) => best(a) - best(b))
	})
	const options = createMemo(() => sections().flatMap((section) => section.options))
	const highlighted = () => options()[Math.min(keyed(), options().length - 1)]?.key

	createEffect(highlighted, (key) => {
		panel
			?.querySelector(`[data-key="${CSS.escape(key ?? '')}"]`)
			?.scrollIntoView({ block: 'nearest' })
	})

	const close = () => panel.hidePopover()
	/** Runs a row; a thread's or bot's, with Ctrl or Cmd held, opens beside */
	const go = (option, event) => {
		close()
		option.run(event)
	}
	const walk = (step) => {
		const count = options().length
		if (count) setKeyed((Math.min(keyed(), count - 1) + step + count) % count)
	}

	onSettled(() => {
		show = () => panel.showPopover()
		const keydown = (event) => {
			const key = event.key.toLowerCase()
			if (event.altKey || event.shiftKey || (key !== 'k' && key !== 'o')) return
			if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return
			event.preventDefault()
			if (event.repeat) return
			// Over another open popover, like the model picker, it waits: opening would close that one
			if (!panel.matches(':popover-open') && document.querySelector(OTHER_OPEN)) return
			panel.togglePopover()
		}
		addEventListener('keydown', keydown)
		return () => {
			show = undefined
			removeEventListener('keydown', keydown)
		}
	})

	return html`
		<div
			class="popover model-picker jump"
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState === 'open') {
					placePopover(panel)
					input.focus()
					return
				}
				input.value = ''
				setTyped('')
				setKeyed(0)
			}}
		>
			<div class="model-controls">
				<div class="search">
					<input
						type="search"
						role="combobox"
						aria-label="Jump to a thread, bot or action"
						aria-expanded="true"
						aria-controls="jump-list"
						aria-activedescendant=${() => (highlighted() ? idOf(highlighted()) : undefined)}
						placeholder="Jump to…"
						enterkeyhint="go"
						autocomplete="off"
						autocapitalize="none"
						autocorrect="off"
						spellcheck="false"
						ref=${(el) => (input = el)}
						onInput=${(event) => {
							setTyped(event.currentTarget.value)
							setKeyed(0)
						}}
						onKeyDown=${(event) => {
							if (event.isComposing) return
							const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
							if (step) walk(step)
							else if (event.key === 'Enter') {
								const option = options().find((each) => each.key === highlighted())
								if (option) go(option, event)
							} else return
							event.preventDefault()
						}}
					/>
					<button type="button" class="ghost small close" aria-label="Close" onClick=${close}>
						<${Icon} name="close" />
					</button>
				</div>
				<ul class="model-list" id="jump-list" role="listbox" aria-label="Threads, bots and actions">
					<${For} each=${sections} keyed=${(section) => section.title}>
						${(section) => html`
							<li role="presentation">
								<h3>${() => section().title}</h3>
								<div class="models" role="group" aria-label=${() => section().title}>
									<${For} each=${() => section().options} keyed=${(option) => option.key}>
										${(option) => JumpRow(option, highlighted, go)}
									<//>
								</div>
							</li>
						`}
					<//>
					<${Show} when=${() => !options().length}>
						<li class="mute">Nothing matches</li>
					<//>
				</ul>
			</div>
		</div>
		<${ThemeMenu} />
	`
}

/** A row like a mention's: its dot, its name, what it is at the end; the keys highlight it, a click or Enter goes */
function JumpRow(option, highlighted, go) {
	return html`
		<button
			type="button"
			role="option"
			id=${() => idOf(option().key)}
			data-key=${() => option().key}
			tabindex="-1"
			aria-selected=${() => String(highlighted() === option().key)}
			class="ghost model"
			onMouseDown=${(event) => event.preventDefault()}
			onClick=${(event) => go(option(), event)}
		>
			<${Show} when=${() => option().state !== undefined}
				><${Dot} state=${() => option().state}
			/><//>
			<span style=${() => (option().color ? colorOf(option().color) : '')}
				>${() => option().label}</span
			>
			<${Show} when=${() => option().note}><small>${() => option().note}</small><//>
		</button>
	`
}
