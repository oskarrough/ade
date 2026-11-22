/** Runners show their agents and choose whom the composer asks. */
import html from '@solidjs/html'
import { createMemo, createSignal, createUniqueId, For, Show } from 'solid-js'
import { api, minted, revokeRunner, runners, setMinted, threadOf, threadRows } from './server.js'
import { rowOf, lastToolCall, modelsOf, thinkingWord } from './agent.js'
import { choose, configure, recipients, toFor } from './composer.js'
import { placePopover } from './popover.js'
import { Panes } from './panes.js'
import { report } from './notice.js'
import { Sure } from './sure.js'
import { busy, Busy } from './busy.js'
import { Dot } from './dot.js'
import { ModelPicker } from './model-picker.js'

export function Runner(props) {
	let pickButton, pickPanel
	const runner = () => props.runner
	const to = () => toFor(runner())
	const agents = () => props.agents.filter((agent) => agent.to.runner === runner().name)
	const models = () => modelsOf(runner(), to())
	const others = () =>
		[...new Map(agents().map((agent) => [rowOf(agent.to), agent.to])).values()].filter(
			(other) => rowOf(other) !== rowOf(to()),
		)
	const stop = (event) => event.stopPropagation()
	const pick = () => choose(to())
	// The card is the mouse's way to ask it; its name is the keyboard's, and a press bubbles up to the card.
	return html`
		<div
			class=${() => [
				'node',
				'card',
				{
					off: !runner().online,
					routed: recipients().some((to) => to.runner === runner().name),
				},
			]}
			data-runner=${() => runner().name}
			title="Click to ask it"
			onClick=${pick}
		>
			<button type="button" class="ask">
				<${Dot} state=${() => dotOf(runner())} />${() => runner().name}
			</button>
			<small>${() => runner().dir}</small>
			<${Show} when=${() => runner().dir && !models().length}
				><small>No models here yet: run pi there and /login.</small><//
			>
			<${Show} when=${() => !runner().dir}
				><small>Not connected yet. Run the command on ${() => runner().name}.</small><//
			>
			<ul class="models">
				<${Show} when=${() => models().length}>
					<${AgentRow} to=${() => to()} runner=${() => runner()} agents=${() => agents()}>
						<button
							type="button"
							class="ghost small pick"
							aria-label="Model"
							aria-expanded="false"
							ref=${(el) => (pickButton = el)}
							onClick=${(event) => {
								stop(event)
								pickPanel.togglePopover()
							}}
						>
							<span>${() => to().model?.split('/').pop() ?? 'Pick a model'}</span
							><${Show} when=${() => to().thinkingLevel}
								><span class="thinking-word">:${() => thinkingWord(to().thinkingLevel)}</span><//
							>
						</button>
						<div
							class="popover model-picker"
							popover
							ref=${(el) => (pickPanel = el)}
							onClick=${stop}
							onToggle=${(event) => {
								pickButton.setAttribute('aria-expanded', String(event.newState === 'open'))
								if (event.newState === 'open') placePopover(pickPanel, pickButton)
							}}
						>
							<${ModelPicker}
								getTo=${(other) => toFor(other)}
								selectedRunner=${() => runner().name}
								onChoose=${(next) => {
									configure(next)
									pickPanel.hidePopover()
								}}
								onConfigure=${(next) => configure(next)}
								onClose=${(_e) => pickPanel.hidePopover()}
							/>
						</div>
					<//>
				<//>
				<${For} each=${() => others()}
					>${(to) => html`
						<${AgentRow} to=${() => to} runner=${() => runner()} agents=${() => agents()}>
							<span class="name" title=${() => to.model}>${() => to.name ?? to.model}</span>
						<//>
					`}<//
				>
			</ul>
		</div>
	`
}

const dotOf = (runner) =>
	runner.status && runner.status !== 'idle' ? runner.status : runner.online ? 'on' : ''

function AgentRow(props) {
	const agents = () => props.agents.filter((agent) => rowOf(agent.to) === rowOf(props.to))
	const status = () => props.runner.agents?.[rowOf(props.to)] ?? 'idle'
	const call = () => lastToolCall(agents())
	return html`
		<li data-agent=${() => rowOf(props.to)}>
			${() => props.children}
			<${Show} when=${() => agents().length}><${Dot} state=${status} title=${status} /><//>
			<${Show} when=${() => call()}
				><span class="hands" title=${() => call()}>${() => call()}</span><//
			>
		</li>
	`
}

export function RunnerList() {
	let button, panel
	const id = createUniqueId()
	const online = () => runners.filter((runner) => runner.online).length
	/** Agents working or waiting, read once for every row: a thread's status turns with its agents', so idle threads are skipped whole */
	const active = createMemo(() =>
		threadRows()
			.open.filter((thread) => thread.status === 'working' || thread.status === 'blocked')
			.flatMap((thread) =>
				thread.agents
					.filter((agent) => agent.status !== 'idle')
					.map((agent) => ({
						thread: thread.id,
						runner: agent.to?.runner,
						status: agent.status,
					})),
			),
	)
	return html`
		<button
			class="ghost small foot-toggle runner-toggle"
			type="button"
			aria-label=${() => `Runners, ${online()} online`}
			title=${() => `${online()} runner${online() === 1 ? '' : 's'} online`}
			ref=${(el) => (button = el)}
			popovertarget=${id}
		>
			<span>Runners</span>
			<small class="count" aria-hidden="true">${() => online()}</small>
		</button>
		<div
			class="popover runner-list"
			id=${id}
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState === 'open') placePopover(panel, button)
			}}
		>
			<${Panes} title="Runners" open=${() => false} onClose=${(_event) => panel.hidePopover()}>
				<ul class="rows">
					<${For} each=${() => runners}
						>${(runner) => html`<${RunnerItem} runner=${() => runner} active=${() => active()} />`}<//
					>
				</ul>
				<${ConnectRunner} />
			<//>
		</div>
	`
}

function RunnerItem(props) {
	const countThreads = (status) =>
		new Set(
			props.active
				.filter((agent) => agent.runner === props.runner.name && agent.status === status)
				.map((agent) => agent.thread),
		).size
	const summary = createMemo(() => {
		const online = props.runner.online
		const count = countThreads(online ? 'working' : 'blocked')
		const threads = count === 1 ? 'thread' : 'threads'
		if (online) return count ? `${count} active ${threads}` : ''
		return count ? `Offline, ${count} ${threads} waiting` : 'Offline'
	})
	const revoke = busy(async () => {
		const { name } = props.runner
		await revokeRunner(name)
		if (minted()?.name === name) setMinted(null)
	})
	return html`
		<li>
			<${Dot} state=${() => dotOf(props.runner)} />
			<div>
				<b>${() => props.runner.name}</b>
				<small>${() => props.runner.dir ?? 'Never connected yet.'}</small>
				<${Show} when=${() => props.runner.dir && summary()}>
					<small class=${() => ({ doing: props.runner.online })}>${summary}</small>
				<//>
			</div>
			<${Sure}
				class="small revoke"
				title=${() =>
					"Take its key away. It goes offline and can't dial back; threads that asked it wait for the name." +
					(props.runner.own
						? " It's the server's own runner, so it's back when the server restarts, unless it starts with --no-runner."
						: '')}
				ask="revoke?"
				onConfirm=${(_event) => revoke()}
				><${Busy} state=${revoke.state}>revoke<//><//
			>
		</li>
	`
}

/** A name makes a key and the command that connects it; a name already in the list gets a new one. */
export function ConnectRunner(props) {
	const [name, setName] = createSignal(props.name ?? '')
	const [error, setError] = createSignal('')
	const [copied, setCopied] = createSignal('')
	// A new key for a runner that has one replaces it, online or not, so the button asks first, in its own words.
	const [cutting, setCutting] = createSignal(false)
	const existing = () => runners.find((runner) => runner.name === name().trim())
	const add = busy(
		async () => {
			setError('')
			setMinted(await api('/api/runners', { name: name().trim() }))
			setName('')
			setCopied('')
		},
		{ onError: (failure) => setError(failure.message) },
	)
	const submit = (event) => {
		event.preventDefault()
		if (existing() && !cutting()) return setCutting(true)
		setCutting(false)
		add()
	}
	const copy = (which) =>
		navigator.clipboard
			.writeText(minted()[which])
			.then(() => setCopied(which))
			.catch(report)
	return html`
		<div class="connect-runner">
			<form onSubmit=${submit}>
				<input
					aria-label="Runner name"
					placeholder="a name, like laptop"
					spellcheck="false"
					autocomplete="off"
					required
					value=${() => name()}
					onInput=${(event) => {
						// A name is letters, digits, dot, dash or underscore: a space becomes a dash as you type.
						const input = event.currentTarget
						const typed = input.value
						const caret = input.selectionStart ?? typed.length
						const tidy = (text) => text.replace(/\s/g, '-').replace(/[^\w.-]/g, '')
						if (tidy(typed) !== typed) {
							input.value = tidy(typed)
							const at = tidy(typed.slice(0, caret)).length
							input.setSelectionRange(at, at)
						}
						setName(input.value)
						setCutting(false)
					}}
				/>
				<button
					type="submit"
					aria-busy=${() => add.state() === 'busy'}
					onBlur=${(_e) => setCutting(false)}
				>
					<${Busy} state=${add.state}
						>${() =>
							cutting()
								? `Replace ${existing()?.name}'s key?`
								: existing()
									? 'New key'
									: 'Add runner'}<//
					>
				</button>
			</form>
			<${Show} when=${cutting}>
				<p class="mute">
					${() =>
						`${name().trim()} is online. A new key cuts it off until you run the new command there.`}
				</p>
			<//>
			<${Show} when=${() => error()}><p class="bad">${() => error()}</p><//>
			<${Show} when=${minted}>
				<p class="mute">On that machine, in the folder agents should start in:</p>
				<div class="command">
					<pre>${() => minted().ade}</pre>
					<button type="button" class="small" onClick=${(_e) => copy('ade')}>
						${() => (copied() === 'ade' ? 'Copied' : 'Copy')}
					</button>
				</div>
				<p class="mute">Without ade installed there:</p>
				<div class="command">
					<pre>${() => minted().connect}</pre>
					<button type="button" class="small" onClick=${(_e) => copy('connect')}>
						${() => (copied() === 'connect' ? 'Copied' : 'Copy')}
					</button>
				</div>
				<${Show}
					when=${() =>
						/^curl -fsSL https?:\/\/(localhost|127(?:\.\d+){3}|\[::1\])[:/]/i.test(
							minted().connect,
						)}
				>
					<p class="mute">
						Other machines can't reach this server. Run <code>tailscale serve</code> on its port to
						reach it from one.
					</p>
				<//>
			<//>
		</div>
	`
}

/** Online runners that have `model`: offering it, or having run it; the scripted echo is on every runner */
export const runnersWith = (model) =>
	runners.filter(
		(runner) =>
			runner.online &&
			(model?.startsWith('echo/') ||
				runner.offers?.includes(model) ||
				runner.models?.includes(model)),
	)

/**
 * Above a thread's composer, each agent waiting for its offline runner, with a button for every online runner that has
 * its model: pressed, it runs there, as the picker would move it, its folder starting over there. A bot moves itself,
 * so asking it anywhere asks it there.
 */
export function Stranded(props) {
	const waiting = createMemo(() =>
		(threadOf(props.thread)?.agents ?? []).filter(
			(agent) =>
				agent.status === 'blocked' &&
				agent.to?.runner &&
				!runners.find((runner) => runner.name === agent.to.runner)?.online,
		),
	)
	const move = (agent, runner) =>
		(agent.to.name
			? api('/api/bots', {
					name: agent.to.name,
					to: {
						runner,
						model: agent.to.model,
						...(agent.to.thinkingLevel && { thinkingLevel: agent.to.thinkingLevel }),
					},
				})
			: Promise.resolve()
		)
			.then(() =>
				api(`/api/threads/${props.thread}/move`, { conversation: agent.conversation, runner }),
			)
			.catch(report)
	return html`
		<${For} each=${waiting}
			>${(agent) => html`
				<p class="notice" role="status">
					<span
						>${() =>
							`${agent.to.runner} is offline${agent.to.name ? `, so ${agent.to.name} waits` : ''}.${runnersWith(agent.to.model).length ? ' Run on' : ' No runner online has its model.'}`}</span
					>
					<${For} each=${() => runnersWith(agent.to.model)}
						>${(runner) => html`
							<button
								type="button"
								class="ghost small"
								title=${() =>
									`${agent.to.name ? `Moves ${agent.to.name} to ${runner.name}, here and wherever it's asked` : `Moves this thread's agent to ${runner.name}`}; its folder starts over in ${runner.dir}`}
								onClick=${(_event) => move(agent, runner.name)}
							>
								${() => runner.name}
							</button>
						`}<//
					>
				</p>
			`}<//
		>
	`
}
