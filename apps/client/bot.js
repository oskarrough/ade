/** A bot's name, home, the agent it joins as, and instructions. */
import html from '@solidjs/html'
import { createEffect, createMemo, createSignal, For, onSettled, Show, snapshot } from 'solid-js'
import {
	api,
	bots,
	colorOf,
	current,
	defaultHueOf,
	forgetBot,
	followThread,
	hrefOf,
	hueOf,
	hues,
	openThread,
	paint,
	reloadBots,
	reloadThreads,
	saveBot,
	threadOf,
	threadRows,
} from './server.js'
import { formatAgent } from './agent.js'
import { agent, openPicker } from './composer.js'
import { Dot } from './dot.js'
import { report } from './notice.js'
import { Sure } from './sure.js'
import { ThreadItem } from './thread-list.js'

const familyOf = (bot) => new Set((threadOf(bot.home)?.family ?? []).map((member) => member.id))

/** Its own threads without the home, and the unarchived threads it joins elsewhere. */
export function botThreads(bot) {
	const family = familyOf(bot)
	const own = [...family].filter((id) => id !== bot.home).sort((a, b) => b - a)
	const elsewhere = threadRows()
		.open.filter(
			(row) =>
				row.id !== bot.home &&
				!family.has(row.id) &&
				row.agents.some((agent) => agent.name === bot.name),
		)
		.map((row) => row.id)
	return { own: own.map(threadOf).filter(Boolean), elsewhere: elsewhere.map(threadOf) }
}

export function BotItem(props) {
	const family = createMemo(() => [...familyOf(props.bot)].map(threadOf).filter(Boolean))
	const working = createMemo(() => family().filter((thread) => thread.status === 'working').length)
	// Its threads' work, questions and failures, which its home lists; an unread answer only in the home itself, since
	// opening the home is what clears it
	const status = createMemo(
		() =>
			['working', 'blocked', 'error'].find((status) =>
				family().some((thread) => thread.status === status),
			) ?? (threadOf(props.bot.home)?.status === 'done' ? 'done' : 'idle'),
	)
	return html`
		<li class=${() => ({ current: props.bot.home === current() })}>
			<a
				class="row"
				href=${() => hrefOf(props.bot.home)}
				title=${() => props.bot.instructions.split('\n')[0]}
				onClick=${(event) => followThread(event, props.bot.home)}
			>
				<${Dot} state=${() => status()} />
				<span style=${() => colorOf(props.bot.name)}>${() => props.bot.name}</span>
				<${Show} when=${() => working()}>
					<small title="Threads working">${() => working()}</small>
				<//>
			</a>
		</li>
	`
}

export function BotSettings(props) {
	let instructionsField
	const [instructions, setInstructions] = createSignal('')
	createEffect(
		() => props.bot.instructions,
		(instructions) => {
			if (document.activeElement !== instructionsField) setInstructions(instructions)
		},
	)
	const own = createMemo(() => {
		const { own, elsewhere } = botThreads(props.bot)
		return [...own, ...elsewhere]
	})
	const count = createMemo(() => own().length)
	/** A new name keeps everything else; the old one stays in messages already written */
	const rename = async (field) => {
		const next = field.value.trim()
		if (next === props.bot.name) return
		try {
			if (bots.some((bot) => bot.name === next)) throw new Error(`${next} is another bot`)
			await saveBot(props.bot.name, { rename: next })
			await reloadThreads()
		} catch (failure) {
			field.value = props.bot.name
			report(failure)
		}
	}
	const holder = (hue) =>
		bots.find((bot) => bot.name !== props.bot.name && hueOf(bot.name) === hue)?.name
	const setColor = (color) => saveBot(props.bot.name, { color }).catch(report)
	// Of its hundreds, the ones happening now or needing a hand, which its row's dot counts; an unread answer elsewhere doesn't
	const active = createMemo(() =>
		own().filter((thread) => ['working', 'blocked', 'error'].includes(thread.status)),
	)
	return html`
		<div class="bot">
			<h3>Name</h3>
			<input
				class="bot-name"
				aria-label="Bot name"
				title="How anyone asks it, in any thread"
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
				value=${() => props.bot.name}
				onChange=${(event) => rename(event.currentTarget)}
				onKeyDown=${(event) => {
					if (event.key === 'Enter') event.currentTarget.blur()
					if (event.key === 'Escape') {
						event.currentTarget.value = props.bot.name
						event.currentTarget.blur()
					}
				}}
			/>
			<h3>Instructions</h3>
			<textarea
				class="instructions"
				ref=${(el) => {
					instructionsField = el
				}}
				rows="8"
				aria-label="Bot instructions"
				placeholder="Who it is, in its words or yours"
				value=${() => instructions()}
				onInput=${(event) => setInstructions(event.currentTarget.value)}
				onChange=${() => saveBot(props.bot.name, { instructions: instructions() }).catch(report)}
			></textarea>
			<h3>Model</h3>
			<button
				type="button"
				class="bot-model"
				title="The model it joins new threads with"
				onClick=${(event) => openPicker(event.currentTarget)}
			>
				${() => formatAgent(props.bot.to)}
			</button>
			<h3>Colour</h3>
			<div class="colors">
				<button
					type="button"
					class="ghost small"
					aria-pressed=${() => String(props.bot.color === undefined)}
					title="The colour it gets by the order bots were made"
					onClick=${() => setColor(null)}
				>
					<span
						class="dot"
						style=${() => `background: ${paint(defaultHueOf(props.bot.name))}`}
					></span>
					Default
				</button>
				<${For} each=${hues}
					>${(hue) =>
						html`<button
							type="button"
							class=${() => ['ghost small', { taken: !!holder(hue) }]}
							aria-pressed=${() => String(props.bot.color === hue)}
							aria-label=${() => (holder(hue) ? `Hue ${hue}, ${holder(hue)}'s` : `Hue ${hue}`)}
							title=${() => (holder(hue) ? `${holder(hue)}'s colour` : '')}
							onClick=${() => setColor(hue)}
						>
							<span class="dot" style=${`background: ${paint(hue)}`}></span>
						</button>`}<//
				>
			</div>
			${() => props.tools}
			<${Show} when=${() => count() > 0}>
				<h3>Threads</h3>
				<ul class="thread-family">
					<${For} each=${active}>${(thread) => html`<${ThreadItem} thread=${() => thread} />`}<//>
					<li class="new">
						<button
							type="button"
							class="row"
							aria-label=${() => `All ${count()} ${count() === 1 ? 'thread' : 'threads'}`}
							onClick=${(event) => props.onThreads(event)}
						>
							<span class="plus" aria-hidden="true"></span>
							<span>All threads</span>
							<small aria-hidden="true">${() => count()}</small>
						</button>
					</li>
				</ul>
			<//>
			<${Sure}
				class="forget"
				title="Every thread stays; agents of its name stop reading its instructions"
				ask=${() => `Forget ${props.bot.name}?`}
				why="Its instructions go; every thread stays."
				onConfirm=${async (_e) => {
					try {
						await forgetBot(props.bot.name)
					} catch (failure) {
						report(failure)
					}
				}}
				>Forget this bot<//
			>
		</div>
	`
}

export function NewBot(props) {
	let input
	const [error, setError] = createSignal('')
	const [name, setName] = createSignal('')
	const [saving, setSaving] = createSignal(false)
	onSettled(() => input.focus())
	const submit = async (event) => {
		event.preventDefault()
		if (saving()) return
		const entered = name().trim()
		if (!entered) return setError('Required')
		if (bots.some((bot) => bot.name === entered)) return setError('Taken')
		if (!/^[\w.-]{1,40}$/.test(entered)) return setError('Invalid')
		setSaving(true)
		try {
			const pick = snapshot(agent() ?? agent(null))
			if (!pick) throw new Error('Pick a model first in New thread')
			const { home } = await api('/api/bots', {
				name: entered,
				to: { ...pick, name: undefined },
			})
			reloadBots()
			openThread(home)
			props.onDone()
		} catch (failure) {
			setError(failure.message)
		} finally {
			setSaving(false)
		}
	}
	return html`
		<li>
			<form class="row" onSubmit=${submit}>
				<input
					ref=${(el) => {
						input = el
					}}
					aria-label="Bot name"
					placeholder="a name"
					enterkeyhint="go"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					class=${() => ['bare', { bad: !!error() }]}
					aria-invalid=${() => !!error()}
					title=${() => error() || 'How anyone asks it, in any thread'}
					value=${() => name()}
					onInput=${(event) => {
						setName(event.currentTarget.value)
						setError('')
					}}
					onBlur=${() => {
						if (!saving() && !name().trim()) props.onDone()
					}}
					onKeyDown=${(event) => {
						if (event.key === 'Escape') props.onDone()
					}}
				/>
				<button type="submit" class="ghost small" disabled=${() => saving()}>Create</button>
				<${Show} when=${() => error()}>
					<small role="alert">${() => error()}</small>
				<//>
			</form>
		</li>
	`
}
