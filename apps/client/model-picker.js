/** Model, thinking and folder controls, without owning a popup or changing a thread themselves. */
import html from '@solidjs/html'
import { createEffect, createSignal, For, onSettled, Show } from 'solid-js'
import { listKeys } from './list-keys.js'
import { api, runners } from './server.js'
import { modelsOf, THINKING_LEVELS, thinkingWord } from './agent.js'
import { Dot } from './dot.js'
import { Icon } from './icons.js'
import { canLogIn, ConnectRunner, LogIn, logins } from './runner.js'
import { CheckoutChoice } from './checkouts.js'

/** Every word of the search is somewhere in the text. */
export const matches = (search, text) =>
	search
		.toLowerCase()
		.split(/\s+/)
		.every((word) => text.toLowerCase().includes(word))

/** Whether a `provider/id` model is billed per token there: an API key rather than a subscription, and not free, as the runner says */
export const metered = (runner, model) => {
	const { metered = [], free = [] } = runners.find((each) => each.name === runner) ?? {}
	return (
		Boolean(model?.includes('/')) && metered.includes(model.split('/')[0]) && !free.includes(model)
	)
}

/** The mark for a model billed per use; subscription models carry none */
export const Metered = () =>
	html`<small class="metered" title="Pay per use: billed per token on an API key">$</small>`

/**
 * A search on top, each runner's models in one list under it, and the thinking and folder of the runner asked pinned at the bottom.
 * Typing filters the list; the keys are every list's. A line that reads as recipients (an `@` or a comma), or matches nothing, goes to `onRecipients` on Enter instead.
 * getTo(runner) supplies each runner's choice; the caller decides when a choice is applied or closes the view.
 * `onClose` puts a close beside the search, which a phone's sheet shows.
 * `checkout` offers a thread about to start the choice of a checkout of its own.
 * `before` is rows above the models while nothing is typed; `after(search)` rows under them, filtered by the caller. Their buttons are `role="option"` to take the keys.
 */
export function ModelPicker(props) {
	let input, list
	const [typed, setTyped] = createSignal('')
	const search = () => typed().trim()
	const online = () => runners.filter((runner) => runner.online)
	/** Online runners first; an offline one shows greyed, so you see where a thread waits, and can't be picked */
	const listed = () => [...online(), ...runners.filter((runner) => !runner.online && runner.dir)]
	const askedRunner = () =>
		runners.find((runner) => runner.name === props.selectedRunner && runner.dir) ?? online()[0]
	const clear = () => {
		input.value = ''
		setTyped('')
	}
	const keys = listKeys({
		field: () => input,
		list: () => list,
		fresh: typed,
		escape: () => input.closest('[popover]')?.hidePopover(),
	})
	// Closing the popover it sits in starts the next opening on an empty search
	onSettled(() => {
		const popover = input.closest('[popover]')
		const closed = (event) => event.newState === 'closed' && clear()
		popover?.addEventListener('toggle', closed)
		return () => popover?.removeEventListener('toggle', closed)
	})
	const recipients = (event) =>
		event.key === 'Enter' &&
		!event.isComposing &&
		props.onRecipients &&
		search() &&
		(/[@,]/.test(search()) || !keys.highlighted())
	return html`
		<div class="model-controls">
			<div class="search">
				<input
					type="search"
					role="combobox"
					aria-expanded="true"
					aria-label="Search models"
					placeholder=${() =>
						props.onRecipients ? 'Search, or type model:thinking@runner' : 'Search models'}
					autocomplete="off"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					autofocus=${!matchMedia('(pointer: coarse)').matches}
					ref=${(el) => (input = el)}
					onInput=${(event) => setTyped(event.currentTarget.value)}
					onKeyDown=${(event) => {
						if (!recipients(event)) return keys.keydown(event)
						event.preventDefault()
						props.onRecipients(search())
						clear()
					}}
				/>
				<${Show} when=${() => props.onClose}>
					<button
						type="button"
						class="ghost small close"
						aria-label="Close"
						onClick=${(event) => props.onClose(event)}
					>
						<${Icon} name="close" />
					</button>
				<//>
			</div>
			<ul class="list" role="listbox" aria-label="Models" ref=${(el) => (list = el)}>
				<${Show} when=${() => !search()}>${() => props.before}<//>
				<${For}
					each=${listed}
					fallback=${html`
						<li class="mute no-runner">
							No runner is online.
							<${ConnectRunner} />
						</li>
					`}
				>
					${(runner) => PickerRunner(runner, props, search, () => askedRunner()?.name)}
				<//>
				${() => props.after?.(search())}
			</ul>
			<${Show} when=${askedRunner}>${() => PickerFoot(askedRunner(), props)}<//>
		</div>
	`
}

/**
 * A runner's name, then its models that match what was typed; nothing when none do.
 * Its scoped models come first; "All models", or a search, reaches every other model pi is logged in for there.
 * A runner with no scoped models lists them all at once, so a fresh house's picker isn't empty.
 * Every runner but the one asked folds to its first model until opened, so a second machine never hides below the first one's list.
 */
function PickerRunner(runner, props, search, askedRunner) {
	const to = () => props.getTo(runner)
	const selected = () => props.selectedRunner === runner.name
	const [opened, setAll] = createSignal(false)
	const [unfolded, setUnfolded] = createSignal(false)
	const folded = () => !search() && !unfolded() && askedRunner() !== runner.name
	const all = () => opened() || !modelsOf(runner, props.getTo(runner)).length
	const [available, setAvailable] = createSignal([])
	let asked = -1
	// Asked once, and again after the window comes back from a login; `runner.name` is read here, tracked, since
	// the effect's callback runs untracked and would otherwise freeze it at the runner it first saw.
	createEffect(
		() => [(search() || all()) && runner.online ? logins() : null, runner.name],
		([round, name]) => {
			if (round === null || asked === round) return
			asked = round
			api(`/api/runners/${encodeURIComponent(name)}/available`).then(setAvailable, () => {
				asked = -1
			})
		},
	)
	/** Only echo answers here: pi isn't logged in to any model */
	const echoOnly = () =>
		available().length > 0 && available().every((model) => model.startsWith('echo/'))
	const found = (model) => matches(search(), `${model} ${runner.name}`)
	const scoped = () => modelsOf(runner, to())
	const scopedFound = () => scoped().filter(found)
	const shown = () => (folded() ? scopedFound().slice(0, 1) : scopedFound())
	const hidden = () => scoped().length - shown().length
	const rest = () =>
		!folded() && (search() || all())
			? available().filter((model) => !scoped().includes(model) && found(model))
			: []
	const choice = (model) => html`
		<button
			type="button"
			role="option"
			class="ghost model"
			disabled=${() => !runner.online}
			aria-pressed=${() => String(selected() && to().model === model)}
			onClick=${() => props.onChoose({ ...to(), model })}
		>
			<span>${() => model.split('/').pop()}</span
			><small>${() => (model.includes('/') ? model.split('/')[0] : '')}</small
			><${Show} when=${() => metered(runner.name, model)}><${Metered} /><//
			><${Show} when=${() => selected() && to().model === model}><${Icon} name="check" /><//>
		</button>
	`
	return html`
		<${Show} when=${() => folded() || scopedFound().length || rest().length}>
			<li class=${() => ({ on: selected(), mute: !runner.online })}>
				<div class="who">
					<${Dot}
						state=${() => (!runner.online ? '' : runner.status === 'idle' ? 'on' : runner.status)}
					/><span>${() => runner.name}</span>
					<${Show} when=${() => !runner.online}><small>offline</small><//>
				</div>
				<div class="models">
					<${For} each=${shown}>${choice}<//>
					<${Show} when=${() => folded() && (hidden() || runner.online)}>
						<button
							type="button"
							role="option"
							class="ghost model"
							onClick=${() => setUnfolded(true)}
						>
							<span>${() => (hidden() ? `${hidden()} more` : 'All models')}</span>
						</button>
					<//>
					<${Show} when=${() => !folded() && !search() && !all() && runner.online}>
						<button type="button" role="option" class="ghost model" onClick=${() => setAll(true)}>
							<span>All models</span>
						</button>
					<//>
					<${Show} when=${() => rest().length}>
						<h3>All models</h3>
						<${For} each=${rest}>${choice}<//>
					<//>
					<${Show} when=${() => !folded() && !search() && echoOnly() && canLogIn(runner)}>
						<p class="login">Only echo answers here. <${LogIn} /></p>
					<//>
				</div>
			</li>
		<//>
	`
}

/** How hard the asked runner's model thinks, and in which folder, under the list however long it gets. */
function PickerFoot(runner, props) {
	const to = () => props.getTo(runner)
	const folderValue = (folder) =>
		folder === runner.dir
			? ''
			: folder.startsWith(`${runner.dir}/`)
				? folder.slice(runner.dir.length + 1)
				: folder
	return html`
		<div class="foot">
			<${Show} when=${() => props.fromRunner && props.fromRunner !== runner.name}>
				<p class="mute">
					${() =>
						`Moving from ${props.fromRunner} to ${runner.name} starts its folder over in ${runner.dir}, unless you name one below.`}
				</p>
			<//>
			<h3>Thinking</h3>
			<div class="thinking">
				<${For} each=${() => THINKING_LEVELS}
					>${(level) => html`
						<button
							type="button"
							class="ghost small"
							title=${() => level}
							aria-pressed=${() => String(to().thinkingLevel === level)}
							onClick=${() =>
								props.onConfigure({
									...to(),
									thinkingLevel: to().thinkingLevel === level ? undefined : level,
								})}
						>
							${() => thinkingWord(level)}
						</button>
					`}<//
				>
			</div>
			<${Show} when=${() => props.folders}>
				<h3>Folder</h3>
				<input
					aria-label="Folder"
					list=${`folders-${runner.name}`}
					placeholder=${runner.dir}
					value=${() => to().dir ?? ''}
					onKeyDown=${(event) => {
						// Enter takes the folder, not the message
						if (event.key !== 'Enter') return
						event.preventDefault()
						event.currentTarget.blur()
					}}
					onChange=${(event) =>
						props.onConfigure({ ...to(), dir: event.currentTarget.value.trim() || undefined })}
				/>
				<datalist id=${`folders-${runner.name}`}>
					<${For} each=${() => runner.folders ?? []}
						>${(folder) => html`<option value=${() => folderValue(folder) || folder}></option>`}<//
					>
				</datalist>
				<${Show} when=${() => props.checkout}>
					<${CheckoutChoice} runner=${runner.name} dir=${() => to().dir} />
				<//>
			<//>
		</div>
	`
}
