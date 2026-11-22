/** The server's settings: its modules, on or off, and memory's and the director's options. Saving restarts it. */
import html from '@solidjs/html'
import {
	createEffect,
	createSignal,
	createStore,
	createUniqueId,
	For,
	Show,
	snapshot,
} from 'solid-js'
import { api, connected, openUsage, server, setChat } from './server.js'
import { ModelPicker } from './model-picker.js'
import { Panes } from './panes.js'
import { agentTo, formatAgent, writtenTo } from './agent.js'
import { busy, Busy } from './busy.js'
import { placePopover } from './popover.js'
import { Switch } from './dot.js'
import { markdown } from './markdown.js'
import { Icon } from './icons.js'
import { PiSessionList } from './pi-sessions.js'

export function Settings() {
	let button, panel
	const id = createUniqueId()
	// The page over the settings: '', a model for 'memory' or 'director', or 'pi-sessions' to import one
	const [picking, setPicking] = createSignal('')
	// One module open at a time: its whole description and its options
	const [expanded, setExpanded] = createSignal('')
	const expand = (module) => setExpanded((name) => (name === module.name ? '' : module.name))
	const all = () => [
		...server().modules.map((name) => ({ name, on: true })),
		...(server().off ?? []).map((name) => ({ name, on: false })),
	]
	const overridden = (name) => server().settings?.overrides.includes(name)
	const editable = () => draft.state === ''
	const on = (module) => draft.modules[module.name] ?? module.on
	const model = () => setting('memory', 'model')
	const directs = (field) => setting('director', field)
	const directorOption = (field, label, unit, least) =>
		html`<div class="option compact-option">
			<span>${label}</span>
			<input
				type="number"
				class="small"
				min=${least}
				aria-label=${`${label}, in ${unit}`}
				disabled=${() => !editable()}
				value=${() => directs(field)}
				onChange=${(event) => {
					const value = Number(event.currentTarget.value)
					if (event.currentTarget.value !== '' && value >= least)
						setDraft((store) => void (store.director[field] = value))
				}}
			/>
			<span>${unit}</span>
		</div>`
	const toggle = (module) =>
		setDraft((store) => {
			if (!module.on === !on(module)) store.modules[module.name] = !module.on
			else delete store.modules[module.name]
		})
	// A pick counts at once, like a module's switch; Save and restart sends it with the rest
	const choose = (to) =>
		setDraft((store) => {
			const chosen = to.model ? formatAgent(to) : ''
			store[picking() === 'director' ? 'director' : 'memory'].model = chosen
		})
	const chosen = () => agentTo(picking() === 'director' ? directs('model') : model())
	const save = busy(async () => {
		setDraft((store) => void (store.state = 'saving'))
		try {
			const { restarts } = await api('/api/settings', {
				modules: snapshot(draft.modules),
				...Object.fromEntries(
					SECTIONS.map((section) => [section, changesIn(section)]).filter(
						([, changed]) => Object.keys(changed).length,
					),
				),
			})
			setDraft((store) => {
				store.modules = {}
				for (const section of SECTIONS) store[section] = {}
				store.state = restarts ? 'restarting' : 'stopped'
			})
		} catch (error) {
			setDraft((store) => void (store.state = ''))
			throw error
		}
	})
	// The page reconnects on its own; once the server is back, the panel is ready for the next change
	createEffect(connected, (up) => {
		if (up)
			setDraft((store) => {
				if (store.state !== 'saving') store.state = ''
			})
	})
	return html`
		<button
			class="ghost small foot-toggle settings-toggle"
			type="button"
			aria-label="Settings"
			title="Settings"
			ref=${(el) => (button = el)}
			popovertarget=${id}
		>
			<${Icon} name="settings" />
		</button>
		<div
			class="popover settings"
			id=${id}
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState === 'open') placePopover(panel, button)
				else setPicking('')
			}}
		>
			<${Panes}
				title="Settings"
				detailTitle=${() =>
					({ director: 'The director’s model', 'pi-sessions': 'Pi sessions' })[picking()] ??
					'Memory’s agent'}
				actions=${html`<button
					type="button"
					class="ghost small story"
					title="Back to the story: the walkthrough, with the live system around this chat"
					onClick=${(_event) => setChat(false)}
				>
					<${Icon} name="story" /><span>Story</span>
				</button>`}
				foot=${html`
					<${Show} when=${() => overridden('MODULES')}>
						<p class="mute">Module switches are locked by MODULES in the server’s environment.</p>
					<//>
					<${Show} when=${() => overridden('MEMORY_MODEL')}>
						<p class="mute">
							Memory’s agent is locked by MEMORY_MODEL in the server’s environment.
						</p>
					<//>
					<${Show} when=${() => overridden('DIRECTOR_MODEL')}>
						<p class="mute">
							The director’s model is locked by DIRECTOR_MODEL in the server’s environment.
						</p>
					<//>
					<${Show}
						when=${() => draft.state === '' || draft.state === 'saving'}
						fallback=${html`<p class="mute" role="status">
							${() =>
								draft.state === 'restarting'
									? 'Saved. The server is restarting; this page reconnects on its own.'
									: 'Saved, and the server stopped: it can’t restart itself here. Start it again with node server.js.'}
						</p>`}
					>
						<button
							type="button"
							class="save"
							disabled=${() => !changes()}
							aria-busy=${() => save.state() === 'busy'}
							onClick=${(_event) => save()}
						>
							<${Busy} state=${save.state}
								>${() =>
									changes()
										? `${changes()} ${changes() === 1 ? 'change' : 'changes'}, save and restart`
										: 'Save and restart'}<//
							>
						</button>
					<//>
				`}
				open=${picking}
				onClose=${(_event) => panel.hidePopover()}
				onBack=${(event) => setPicking('')}
				detail=${html`<${Show}
					when=${() => picking() === 'pi-sessions'}
					fallback=${html` <div class="model-for">
							<${Show}
								when=${() => picking() === 'director'}
								fallback=${html`<p>
									<b>Memory’s model</b><br />
									Writes and merges memory’s lines. Choose a cheaper model here without changing the
									thread’s agent.
								</p>`}
							>
								<p>
									<b>The director’s model</b><br />
									Picks who answers a group message that names no one. A small, quick model does it
									best.
								</p>
							<//>
						</div>
						<${ModelPicker}
							getTo=${(runner) =>
								chosen().runner === runner.name
									? chosen()
									: { runner: runner.name, model: runner.model }}
							selectedRunner=${() => chosen().runner}
							before=${html`<li class="models">
								<button
									type="button"
									class="ghost model"
									aria-pressed=${() => String(!chosen().model)}
									onClick=${() => choose(agentTo(''))}
								>
									<span
										>${() =>
											picking() === 'director'
												? 'Haiku or Luna, else each thread’s agent'
												: 'Each thread’s agent'}</span
									>
								</button>
							</li>`}
							onChoose=${(to) => choose(to)}
							onConfigure=${(to) => choose(to)}
						/>`}
					><${PiSessionList}
						onLoaded=${() => setTimeout(() => placePopover(panel, button))}
						onStarted=${() => panel.hidePopover()}
				/><//>`}
			>
				<${Show} when=${() => server().modules.includes('usage')}>
					<ul class="rows">
						<li
							role="button"
							tabindex="0"
							onClick=${() => {
								panel.hidePopover()
								openUsage()
							}}
							onKeyDown=${(event) => {
								if (event.key !== 'Enter') return
								panel.hidePopover()
								openUsage()
							}}
						>
							<div>
								<b>Usage</b>
								<small>Tokens and cost across the house.</small>
							</div>
							<${Icon} name="next" />
						</li>
					</ul>
				<//>
				<ul class="rows modules">
					<${For} each=${all}
						>${(module) => html`
							<li class=${() => ({ off: !on(module), open: expanded() === module.name })}>
								<div
									class="about"
									role="button"
									tabindex="0"
									aria-expanded=${() => String(expanded() === module.name)}
									onClick=${(event) => {
										// A link in the description opens itself, not the row
										if (!event.target.closest('a')) expand(module)
									}}
									onKeyDown=${(event) => {
										if (event.target !== event.currentTarget) return
										if (event.key !== 'Enter' && event.key !== ' ') return
										event.preventDefault()
										expand(module)
									}}
								>
									<b>${() => module.name}</b>
									${
										// Its own template: the markdown it fills in would throw off the walk to what follows
										html`<small
											class="markdown"
											innerHTML=${() => markdown(server().about?.[module.name] ?? 'Your own module.')}
										/>`
									}
								</div>
								<${Switch}
									on=${() => on(module)}
									title=${() => `${module.name}: ${on(module) ? 'on' : 'off'}`}
									disabled=${() => !editable() || overridden('MODULES')}
									onToggle=${() => toggle(module)}
								/>
								<${Show}
									when=${() => module.name === 'memory' && expanded() === 'memory' && on(module)}
								>
									<div class="options">
										<div class="option">
											<span>Writes its lines</span>
											<button
												type="button"
												class="small"
												disabled=${() => !editable() || overridden('MEMORY_MODEL')}
												title=${() => model() || 'Haiku or Luna on each thread’s runner'}
												onClick=${(event) => setPicking('memory')}
											>
												${() => (model() ? shown(model()) : 'Haiku or Luna')}
											</button>
										</div>
										<div class="option compact-option">
											<span>Compacts past</span>
											<input
												type="number"
												class="small"
												min="10"
												step="10"
												aria-label="Compacts past, in thousands of tokens"
												disabled=${() => !editable()}
												value=${() => Math.round(setting('memory', 'compactAt') / 1000)}
												onChange=${(event) => {
													const thousands = Number(event.currentTarget.value)
													if (thousands > 0)
														setDraft((store) => void (store.memory.compactAt = thousands * 1000))
												}}
											/>
											<span>k tokens</span>
										</div>
									</div>
								<//>
								<${Show}
									when=${() => module.name === 'bots' && expanded() === 'bots' && on(module)}
								>
									<div class="options">
										<div class="option">
											<span>Every bot reads this on top of its own instructions</span>
										</div>
										<textarea
											rows="6"
											aria-label="Shared bot instructions"
											disabled=${() => !editable()}
											value=${() => setting('bots', 'voice')}
											onInput=${(event) =>
												setDraft((store) => void (store.bots.voice = event.currentTarget.value))}
										></textarea>
									</div>
								<//>
								<${Show}
									when=${() =>
										module.name === 'director' && expanded() === 'director' && on(module)}
								>
									<div class="options">
										<div class="option">
											<span>Picks with</span>
											<button
												type="button"
												class="small"
												disabled=${() => !editable() || overridden('DIRECTOR_MODEL')}
												title=${() => directs('model') || 'Haiku or Luna on each thread’s runner'}
												onClick=${(event) => setPicking('director')}
											>
												${() => (directs('model') ? shown(directs('model')) : 'Haiku or Luna')}
											</button>
										</div>
										${directorOption('context', 'Reads the last', 'messages', 1)}
										${directorOption('timeout', 'Gives up after', 'seconds', 1)}
										${directorOption('burst', 'Waits for more', 'seconds', 0)}
									</div>
								<//>
								<${Show}
									when=${() =>
										module.name === 'pi-sessions' &&
										expanded() === 'pi-sessions' &&
										server().modules.includes('pi-sessions')}
								>
									<div class="options">
										<div class="option">
											<span>Brings a pi session in as a thread</span>
											<button
												type="button"
												class="small"
												onClick=${(event) => setPicking('pi-sessions')}
											>
												Import pi session
											</button>
										</div>
									</div>
								<//>
							</li>
						`}<//
					>
				</ul>
			<//>
		</div>
	`
}

/** A chosen model as a button shows it; one with no runner of its own runs on each thread's */
const shown = (text) => {
	const to = agentTo(text)
	return to.runner ? writtenTo(to) : writtenTo({ ...to, runner: '' }).slice(0, -1)
}

/** Changes not saved yet, kept if the settings close before saving: module switches, then each section's fields */
const [draft, setDraft] = createStore({
	modules: {},
	memory: {},
	director: {},
	bots: {},
	state: '',
})
const SECTIONS = ['memory', 'director', 'bots']
/** What the server runs for a field it may leave unset */
const DEFAULTS = { memory: { model: '', compactAt: 100000 }, director: {}, bots: { voice: '' } }
const running = (section, field) =>
	server().settings?.[section]?.[field] ?? DEFAULTS[section][field]
/** A field as it will be saved: the draft's, else the server's */
const setting = (section, field) => draft[section][field] ?? running(section, field)
/** A section's fields that differ from what the server runs */
const changesIn = (section) =>
	Object.fromEntries(
		Object.entries(draft[section]).filter(([field, value]) => value !== running(section, field)),
	)
/** How many switches and fields differ from what the server runs */
const changes = () =>
	Object.keys(draft.modules).length +
	SECTIONS.reduce((count, section) => count + Object.keys(changesIn(section)).length, 0)
