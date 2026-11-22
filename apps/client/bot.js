/** A bot's name, home, the agent it joins as, and instructions. */
import html from '@solidjs/html'
import { createEffect, createSignal, For, onSettled, Show, snapshot } from 'solid-js'
import {
	bots,
	colorOf,
	current,
	familyOf,
	forgetBot,
	followThread,
	hrefOf,
	hueOf,
	hues,
	openThread,
	paint,
	saveBot,
	server,
	threadOf,
	threadRows,
	write,
} from './server.js'
import { formatAgent, liveOf } from './agent.js'
import { agent, openPicker } from './composer.js'
import { copyText, nativeMenu } from './desktop.js'
import { Dot, Switch } from './dot.js'
import { report } from './notice.js'
import { openTaskForm } from './schedule.js'
import { openSide } from './side.js'
import { Sure } from './sure.js'
import { rename } from './thread-list.js'
import { cards, HoverCard } from './hover-card.js'

const botFamily = (bot) => new Set(familyOf(bot.home).map((member) => member.id))

/** Its own threads without the home, and the unarchived threads it joins elsewhere. */
export function botThreads(bot) {
	const family = botFamily(bot)
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

/** A bot row's right-click menu in arbe desktop */
const botMenu = (bot) => [
	{ label: 'Open', run: () => openThread(bot.home) },
	{
		label: 'Settings',
		run: () => {
			openThread(bot.home)
			openSide(bot.home, 'details')
		},
	},
	{ label: 'Rename…', run: () => rename(bot.home) },
	{ label: 'Copy link', run: () => copyText(new URL(hrefOf(bot.home), location.href).href) },
	server().modules.includes('schedule') && {
		label: 'Schedule a task…',
		run: () => openTaskForm(bot.home),
	},
]

export function BotItem(props) {
	return html`
		<li class=${() => ({ current: props.bot.home === current() })}>
			<a
				class="row"
				href=${() => hrefOf(props.bot.home)}
				title=${() => (cards ? undefined : props.bot.instructions.split('\n')[0])}
				onClick=${(event) => followThread(event, props.bot.home)}
				onContextMenu=${(event) => nativeMenu(event, botMenu(props.bot))}
			>
				<${Dot} state=${() => props.bot.status} />
				<span style=${() => colorOf(props.bot.name)}>${() => props.bot.name}</span>
				<${Show} when=${() => props.bot.working}>
					<small title="Threads working">${() => props.bot.working}</small>
				<//>
			</a>
			<${HoverCard} content=${() => html`<${BotCard} bot=${() => props.bot} />`} />
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
	/** A new name keeps everything else; the old one stays in messages already written */
	const rename = async (field) => {
		const next = field.value.trim()
		if (next === props.bot.name) return
		try {
			if (bots.some((bot) => bot.name === next)) throw new Error(`${next} is another bot`)
			await saveBot(props.bot.name, { rename: next })
		} catch (failure) {
			field.value = props.bot.name
			report(failure)
		}
	}
	const holder = (hue) =>
		bots.find((bot) => bot.name !== props.bot.name && hueOf(bot.name) === hue)?.name
	const setColor = (color) => saveBot(props.bot.name, { color }).catch(report)
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
			<div class="hands">
				<${Switch}
					on=${() => props.bot.projectContext !== false}
					title="Its agents read the AGENTS.md files in their folder; off leaves them out, and skills stay"
					onToggle=${(on) => saveBot(props.bot.name, { projectContext: on }).catch(report)}
					><span>AGENTS.md</span><//
				>
			</div>
			<h3>Colour</h3>
			<div class="colors">
				<button
					type="button"
					class="ghost small"
					aria-pressed=${() => String(!props.bot.customColor)}
					title="The colour it gets by the order bots were made"
					onClick=${() => setColor(null)}
				>
					<span class="dot" style=${() => `background: ${paint(props.bot.defaultColor)}`}></span>
					Default
				</button>
				<${For} each=${hues}
					>${(hue) =>
						html`<button
							type="button"
							class=${() => ['ghost small', { taken: !!holder(hue) }]}
							aria-pressed=${() => String(props.bot.customColor && props.bot.color === hue)}
							aria-label=${() => (holder(hue) ? `Hue ${hue}, ${holder(hue)}'s` : `Hue ${hue}`)}
							title=${() => (holder(hue) ? `${holder(hue)}'s colour` : '')}
							onClick=${() => setColor(hue)}
						>
							<span class="dot" style=${`background: ${paint(hue)}`}></span>
						</button>`}<//
				>
			</div>
		</div>
	`
}

/** Forget: the bot's instructions go, every thread it was in stays */
export const ForgetBot = (props) => html`
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
`

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
			const { home } = await write('/api/bots', {
				name: entered,
				to: { ...pick, name: undefined },
			})
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

/** A bot's open threads, working ones first, each a link */
const botCardThreads = (bot) => {
	const { own, elsewhere } = botThreads(bot)
	const open = [...own, ...elsewhere].filter((thread) => thread && !thread.archived)
	return [
		...open.filter((thread) => thread.status === 'working'),
		...open.filter((thread) => thread.status !== 'working'),
	]
}

const BotCard = (props) => html`
	<${Show} when=${() => props.bot.instructions}>
		<small class="about">${() => props.bot.instructions.split('\n')[0]}</small>
	<//>
	<${Show} when=${() => botCardThreads(props.bot).length}>
		<ul class="rows">
			<${For} each=${() => botCardThreads(props.bot)}>
				${(thread) =>
					html`<li>
						<a
							class="row"
							href=${() => hrefOf(thread.id)}
							onClick=${(event) => followThread(event, thread.id)}
						>
							<${Dot} state=${() => thread.status} />
							<span>${() => thread.title}</span>
							<small>${() => liveOf(thread)}</small>
						</a>
					</li>`}
			<//>
		</ul>
	<//>
`
