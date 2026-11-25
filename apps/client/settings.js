/** The server's settings: its modules, on or off, and memory's and the director's options. Saving restarts it. */
import html from '@solidjs/html'
import { createSignal, createStore, For, onSettled, Show, snapshot } from 'solid-js'
import { me, openUsage, restart, restarting, server, setChat } from './server.js'
import { forgetLink, loadInvites, People } from './people.js'
import { ModelPicker } from './model-picker.js'
import { Panes } from './panes.js'
import { agentTo, formatAgent, writtenTo } from './agent.js'
import { busy, Busy } from './busy.js'
import { Popover } from './popover.js'
import { Switch } from './dot.js'
import { aboutModule } from './markdown.js'
import { Icon } from './icons.js'
import { PiSessionList } from './pi-sessions.js'

export function Settings() {
	let panel
	// The page over the settings: '', a model for 'memory' or 'director', or 'pi-sessions' to import one
	const [picking, setPicking] = createSignal('')
	// One module open at a time: its whole description and its options
	const [expanded, setExpanded] = createSignal('')
	const expand = (module) => setExpanded((name) => (name === module.name ? '' : module.name))
	const all = () => [
		...server().modules.map((name) => ({ name, on: true })),
		...(server().off ?? []).map((name) => ({ name, on: false })),
	]
	const owns = () => me() === server().settings?.owner
	const invitesOn = () => draft.invites ?? Boolean(server().settings?.invites)
	const overridden = (name) => server().settings?.overrides.includes(name)
	const editable = () => !restarting() && save.state() !== 'busy'
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
	// With nothing changed it only restarts; either way the page reloads once the server is back
	const save = busy(() =>
		restart(
			changes()
				? {
						modules: snapshot(draft.modules),
						...(draft.invites !== undefined && { invites: draft.invites }),
						...Object.fromEntries(
							SECTIONS.map((section) => [section, changesIn(section)]).filter(
								([, changed]) => Object.keys(changed).length,
							),
						),
					}
				: undefined,
		),
	)
	return html`
		<${Popover}
			class="settings"
			button=${() =>
				html`<button
					class="ghost small foot-toggle settings-toggle"
					type="button"
					aria-label="Settings"
					title="Settings"
				>
					<${Icon} name="settings" />
				</button>`}
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState === 'open') {
					if (owns()) loadInvites()
				} else {
					setPicking('')
					forgetLink()
				}
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
						when=${() => restarting() !== 'stopped'}
						fallback=${html`<p class="mute" role="status">
							The server stopped: it can’t restart itself here. Start it again with node server.js.
						</p>`}
					>
						<button
							type="button"
							class="save"
							data-fuzz-skip
							disabled=${() => save.state() === 'busy' || Boolean(restarting())}
							aria-busy=${() => save.state() === 'busy' || Boolean(restarting())}
							onClick=${(_event) => save()}
						>
							<${Busy} state=${() => (restarting() ? 'busy' : save.state())}
								>${() =>
									restarting()
										? 'Restarting…'
										: changes()
											? `${changes()} ${changes() === 1 ? 'change' : 'changes'}, save and restart`
											: 'Restart'}<//
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
									<span>Memory’s model</span><br />
									Writes and merges memory’s lines. Choose a cheaper model here without changing the
									thread’s agent.
								</p>`}
							>
								<p>
									<span>The director’s model</span><br />
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
							before=${html`<li class="models" role="presentation">
								<button
									type="button"
									role="option"
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
									<${Show} when=${() => !chosen().model}><${Icon} name="check" /><//>
								</button>
							</li>`}
							onChoose=${(to) => choose(to)}
							onConfigure=${(to) => choose(to)}
						/>`}
					><${PiSessionList} onStarted=${() => panel.hidePopover()}
				/><//>`}
			>
				<${Show} when=${() => server().modules.includes('usage')}>
					<ul class="rows">
						<li>
							<button
								type="button"
								class="row"
								onClick=${() => {
									panel.hidePopover()
									openUsage()
								}}
							>
								<div>
									<span>Usage</span>
									<small>Tokens and cost across the house.</small>
								</div>
								<${Icon} name="next" />
							</button>
						</li>
					</ul>
				<//>
				<${Show} when=${owns}>
					<${People}
						on=${invitesOn}
						disabled=${() => !editable()}
						onToggle=${() =>
							setDraft((store) => {
								if (store.invites === undefined) store.invites = !invitesOn()
								else delete store.invites
							})}
					/>
				<//>
				<h3>Modules</h3>
				<ul class="rows modules">
					<${For} each=${all}
						>${(module) => {
							// Parsing every module's README at once is the list's whole first-render cost; a tick
							// later costs nothing the user notices and keeps the list itself light to mount.
							const [about, setAbout] = createSignal('')
							onSettled(() =>
								queueMicrotask(() => setAbout(aboutModule(server().about?.[module.name]))),
							)
							return html`
								<li class=${() => ({ off: !on(module), open: expanded() === module.name })}>
									<div
										class="about"
										onClick=${(event) => {
											// A link in the description opens itself, not the row; the name is the button for keys
											if (!event.target.closest('a')) expand(module)
										}}
									>
										<button type="button" aria-expanded=${() => String(expanded() === module.name)}>
											${() => module.name}
										</button>
										${
											// Its own template: the markdown it fills in would throw off the walk to what follows
											html`<small class="markdown" innerHTML=${about} />`
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
							`
						}}<//
					>
				</ul>
			<//>
		<//>
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
	/** Invites on or off, while it differs from what the server runs */
	invites: undefined,
	memory: {},
	director: {},
	bots: {},
})
const SECTIONS = ['memory', 'director', 'bots']
/** What the server runs for a field it may leave unset */
const DEFAULTS = {
	memory: { model: '', compactAt: 100000 },
	director: {},
	bots: { voice: '' },
}
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
	Number(draft.invites !== undefined) +
	SECTIONS.reduce((count, section) => count + Object.keys(changesIn(section)).length, 0)
