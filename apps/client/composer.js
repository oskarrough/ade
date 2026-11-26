/**
 * Each thread keeps its draft, images and pick when you move away; a new thread keeps its own.
 * Drafts are saved on the server as you type, yours alone, so they survive a reload and follow you to another device;
 * Send posts under the draft's key, which empties it there in the same step. A new thread's draft goes into the thread
 * its Send creates, under the same key.
 * Asking a thread's agent as another model switches it. A pick is one model plus any bots; in a bot's home, it is the bot's model.
 * In a group thread, a message whose sender chose no one goes without `to`, and a choice holds for one message.
 * The inbox mounts the same composer under each question (`inbox`): it sends as the thread's own would, without opening it.
 */
import { defaultTitle } from './title.js'
import { threadMention } from './markdown.js'
import html from '@solidjs/html'
import { Icon } from './icons.js'
import {
	createEffect,
	createMemo,
	createSignal,
	createStore,
	For,
	onSettled,
	Show,
	snapshot,
	untrack,
} from 'solid-js'
import {
	api,
	bots,
	botAgent,
	colorOf,
	createThread,
	current,
	entries,
	homeBot,
	loadEarlier,
	me,
	openThread,
	people,
	runners,
	saveBot,
	sending,
	server,
	subscribeView,
	threadRows,
	threadOf,
	url,
} from './server.js'
import { agentTo, clampLevel, formatAgent, levelsOf, shortLabel, THINKING_LEVELS } from './agent.js'
import { placePopover, Popover } from './popover.js'
import { matches, metered, Metered, ModelPicker } from './model-picker.js'
import { listKeys } from './list-keys.js'
import { conversations } from './run.js'
import { Compaction, Memory } from './agent-memory.js'
import { Panes } from './panes.js'
import { Notice, report } from './notice.js'
import { Busy, busy } from './busy.js'
import { ScheduledTasks } from './schedule.js'
import { Stranded } from './runner.js'
import { imageContent, imageUrl } from './images.js'

export function Composer(props) {
	let input, box, picker, chooser, anchor, recall, mentionList, mentionRows
	// So appendQuote can reach this thread's box from outside, even when it isn't the active one
	onSettled(() => {
		const key = untrack(() => props.thread ?? 'new')
		textareas.set(key, input)
		return () => {
			if (textareas.get(key) === input) textareas.delete(key)
		}
	})
	const [mention, setMention] = createSignal(null)
	const mentionable = () =>
		!mention()
			? []
			: mention().slash
				? skillsFor(mention().query, props.thread)
				: mentionsFor(mention().query, props.thread)
	/** `@` anywhere lists bots and threads; `/` opening the message lists the skills of the runner it asks */
	const findMention = () => {
		const before = input.value.slice(0, input.selectionStart)
		const caret = input.selectionStart === input.selectionEnd
		const found = caret && before.match(/(?:^|[\s(])@([\w.-]*)$/)
		const slash = caret && before.match(/^\/(?:skill:)?([\w.-]*)$/)
		const next = found
			? { start: before.length - found[1].length - 1, query: found[1] }
			: slash
				? { start: 0, query: slash[1], slash: true }
				: null
		if (slash) loadSkills(props.thread)
		setMention(next)
	}
	/** A bot goes in as `@name` and asks it; a thread as `@"its title"`, which the message shows as a link to it */
	const pickMention = (option) => {
		const { start } = mention()
		const text = `${input.value.slice(0, start)}${option.written} `
		const value = text + input.value.slice(input.selectionStart).replace(/^\s/, '')
		changeDraft((draft) => {
			draft.text = value
		})
		input.value = value
		input.setSelectionRange(text.length, text.length)
		setMention(null)
		input.focus()
		const { bot } = option
		if (!bot) return
		// It asks the bots the draft mentions, as a mention of bots already here does
		const named = value.toLowerCase()
		const kept = askedBots(props.thread).filter(
			(to) => to.name !== bot.name && named.includes(`@${to.name.toLowerCase()}`),
		)
		setPick(null, [...snapshot(kept), botAgent(bot)], props.thread)
	}
	const mentionKeys = listKeys({
		field: () => input,
		list: () => mentionRows,
		fresh: () => JSON.stringify(mention()),
		tab: true,
		escape: () => setMention(null),
	})
	createEffect(
		() => mentionable().length > 0,
		(open) => {
			if (!mentionList) return
			mentionList.togglePopover(open)
			if (open)
				onSettled(() => {
					mentionList.style.setProperty('--composer-width', `${box.offsetWidth}px`)
					placePopover(mentionList, box, false)
				})
		},
	)
	const asking = () =>
		members().group && !pick(props.thread)
			? ''
			: whom()
					.map((to) => recipientWords(to, props.thread).filter(Boolean).join(':'))
					.join(' + ')
	const [lines, setLines] = createSignal(false)
	const filled = () => {
		const agent = here(props.thread).find((agent) => agent.contextWindow)
		const used = (conversations[agent?.conversation] ?? []).findLast(
			(entry) => entry.kind === 'pi.assistant',
		)?.model?.[0]?.usage?.totalTokens
		return used && { used, share: Math.round((used / agent.contextWindow) * 100) }
	}
	const compactNow = busy(() => api(`/api/threads/${props.thread}/compact`, {}))
	const stop = busy(() => api(`/api/threads/${props.thread}/stop`, {}))
	const draft = () => compose.drafts[props.thread ?? 'new'] ?? emptyDraft
	const changeDraft = (change, key = props.thread ?? 'new', fields = ['text']) =>
		changeDraftFor(key, change, fields)
	const touch = () => matchMedia('(pointer: coarse)').matches
	/** The open thread's composer; one in the inbox is live too, but answering there never opens the thread */
	const open = () => !props.inbox && current() === props.thread
	const active = () => props.inbox || open()
	const enter = () => props.inbox || openThread(props.thread)
	/** An inbox answer's refusal shows above its own box, which may be far below the inbox's top */
	const from = props.inbox ? Symbol('inbox answer') : undefined
	const say = (error) => report(error, from)
	/** Whom it asks: in the inbox, the agent that asked, and no one until the thread's list knows it; never a guess from history */
	const whom = () => (props.inbox ? [props.asks].filter(Boolean) : recipients(props.thread))
	/**
	 * Who's in the thread, as the placeholder names them: its agents and bots, or whom it asks before any is here, then the
	 * other people who wrote or read. A group is more than one agent, or anyone besides you.
	 */
	// Read by the textarea's placeholder, which reruns on every keystroke along with the rest of its bindings;
	// memoized so typing doesn't redo this lookup each time, only when who's in the thread actually changes.
	const members = createMemo(() => {
		const agents = here(props.thread).map((agent) => shortLabel(agent.name))
		const others = (people[props.thread] ?? [])
			.filter((name) => name !== me())
			.map((name) => shortLabel(name))
		return {
			names: [
				...new Set([
					...(agents.length ? agents : whom().map((to) => recipientWords(to, props.thread)[0])),
					...others,
				]),
			],
			group: !props.inbox && !homeBot(props.thread) && (agents.length > 1 || others.length > 0),
		}
	})
	const free = () => !props.inbox && directing(props.thread) && !pick(props.thread)
	// Coming to a thread takes up its draft as saved, which another device may have changed meanwhile, then each change
	createEffect(
		() => active() && (props.thread ?? 'new'),
		(thread) => {
			if (!thread) return
			const draft = subscribeView(`draft/${thread}`, { heard: heardDraft })
			loadDraft(thread)
			return () => draft.release()
		},
	)
	createEffect(
		() => [draft().text, active()],
		() => {
			if (CSS.supports('field-sizing', 'content')) return
			onSettled(() => {
				input.style.height = 'auto'
				input.style.height = `${input.scrollHeight}px`
			})
		},
	)
	createEffect(open, (on) => {
		if (!on) return
		input.focus()
		lend = (from) => {
			if (picker.matches(':popover-open')) return picker.hidePopover()
			anchor = from
			picker.showPopover()
		}
	})
	const add = async (files) => {
		const key = props.thread ?? 'new'
		for (const file of files)
			try {
				const image = await imageContent(file)
				changeDraft(
					(draft) => {
						draft.images.push(image)
					},
					key,
					['images'],
				)
			} catch (error) {
				say(error)
			}
		input.focus()
	}
	const imagesIn = (list) =>
		[...(list ?? [])]
			.filter((file) => file.kind !== 'string')
			.map((file) => file.getAsFile?.() ?? file)
			.filter((file) => file?.type.startsWith('image/'))
	const submit = async (event) => {
		event.preventDefault()
		// A thread you didn't choose for asks whom the server decides, so its rules (one agent, Pause) hold
		const toDirector =
			free() ||
			Boolean(
				props.thread &&
				!props.inbox &&
				!homeBot(props.thread) &&
				(!pick(props.thread) || pick(props.thread).held) &&
				here(props.thread).length,
			)
		if (draft().sending || (!toDirector && !whom().length)) return
		if (!draft().text.trim() && !draft().images.length) return
		const body = draft().text,
			images = snapshot(draft().images),
			to = snapshot(whom())
		// It posts under its draft's key, so it lands once and empties that draft wherever it's open
		const sent = draft().key || crypto.randomUUID()
		const message = { body, key: sent, ...(images.length && { images }) }
		const post = { ...message, steer: true, ...(toDirector && props.thread ? {} : { to }) }
		// A choice holds for one message, including the invitation that turns a solo thread into a group
		if (props.thread && !props.inbox) setCompose((store) => void delete store.picks[props.thread])
		let id = props.thread
		const key = id ?? 'new'
		cancelSave(key)
		spent.add(sent)
		changeDraft(
			(draft) => {
				draft.sending = true
				draft.text = ''
				draft.images = []
				draft.key = crypto.randomUUID()
			},
			key,
			[],
		)
		// Sending ends your typing: the server ends it with the message too, and this stop outranks any beat still on its way
		if (beat.thread) typed(beat.thread, '')
		let sentRow
		/** What's on its way, so a page closing before it lands saves it back under its key */
		const going = { thread: key, key: sent, text: body }
		sendingNow.add(going)
		try {
			if (id) {
				if (!/^\$\s/.test(body)) sentRow = sending(id, message)
				const posted = await api(`/api/threads/${id}/entries`, post)
				sentRow?.settle(posted.seq, posted.boot)
			} else
				// A new thread and its first message are made in one step, under the draft's key
				id = going.thread = await createThread(defaultTitle(body), post)
		} catch (error) {
			sentRow?.drop()
			spent.delete(sent)
			// Back in the box under its own key: if it landed after all, saving it says so and it goes again
			changeDraft(
				(draft) => {
					if (draft.text || draft.images.length) return
					Object.assign(draft, {
						text: body,
						images,
						key: sent,
						restored: body,
					})
				},
				id ?? key,
				['text', 'images'],
			)
			say(error)
		} finally {
			sendingNow.delete(going)
			changeDraft(
				(draft) => {
					draft.sending = false
				},
				key,
				[],
			)
		}
	}
	/** The bots the search matches, under the models */
	const pickerBots = (search) => {
		const matching = () => bots.filter((bot) => matches(search, bot.name))
		return html`
			<${Show} when=${() => matching().length}
				><li role="presentation"><h3>Bots</h3></li><//
			>
			<${For} each=${matching}>
				${(bot) =>
					PickerBot(
						bot,
						() => picker.hidePopover(),
						() => props.thread,
					)}
			<//>
		`
	}
	/** A line of `model:thinking@runner` and bots' names, comma between them, as the pick */
	const pickRecipients = (text) => {
		const next = text
			.split(',')
			.map((text) => text.trim())
			.filter(Boolean)
			.map((text) => {
				const bot = bots.find((bot) => bot.name === text)
				return (
					here(props.thread).find((agent) => agent.name === text)?.to ??
					(bot ? botAgent(bot) : agentTo(text))
				)
			})
		setPick(
			next.find((to) => !to.name) ?? null,
			next.filter((to) => to.name),
			props.thread,
		)
	}
	return html`
		<form
			class=${() => ({ compose: open(), elsewhere: !active() })}
			onSubmit=${submit}
			onDragOver=${(event) => {
				if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
			}}
			onDrop=${(event) => {
				const files = imagesIn(event.dataTransfer.files)
				if (!files.length) return
				event.preventDefault()
				enter()
				add(files)
			}}
		>
			<${Show} when=${() => props.thread} keyed>
				${(thread) => html`<${Stranded} thread=${thread} />`}
			<//>
			<${Show} when=${() => server().modules?.includes('schedule') && props.thread} keyed>
				${(thread) => html`<${ScheduledTasks} thread=${thread} />`}
			<//>
			<${Show} when=${active}><${Notice} from=${from} /><//>
			<${Show} when=${() => draft().images.length}>
				<ul class="images" aria-label="Images to send">
					<${For} each=${() => draft().images}
						>${(image, index) => html`
							<li>
								<img src=${() => imageUrl(image)} alt="" />
								<button
									type="button"
									class="small"
									aria-label="Take this image off"
									onClick=${(_e) =>
										changeDraft(
											(draft) => {
												draft.images.splice(index(), 1)
											},
											undefined,
											['images'],
										)}
								>
									<${Icon} name="close" />
								</button>
							</li>
						`}<//
					>
				</ul>
			<//>
			<div class="box" ref=${(el) => (box = el)}>
				<textarea
					class=${() => ({ draft: true, elsewhere: !active() })}
					ref=${(el) => (input = el)}
					rows="1"
					autocomplete="off"
					enterkeyhint=${() => (touch() ? 'enter' : 'send')}
					role="combobox"
					aria-autocomplete="list"
					aria-expanded=${() => String(mentionable().length > 0)}
					onBlur=${() => setMention(null)}
					onClick=${findMention}
					onKeyUp=${(event) => {
						if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) findMention()
					}}
					onKeyDown=${(event) => {
						// Pi's keys come before the @ list's, whose Tab takes a mention but whose Shift+Tab is pi's
						const key = piKey(event)
						const applied =
							key === 'picker'
								? (picker.showPopover(), true)
								: key === 'thinking'
									? cycleThinking(props.thread)
									: key && cycleModel(props.thread, key === 'next' ? 1 : -1)
						// Ctrl+P never prints from the box; Shift+Tab moves focus back when there's nothing to cycle
						if (key) return (applied || key !== 'thinking') && event.preventDefault()
						if (mentionable().length && mentionKeys.keydown(event)) return
						if (event.key !== 'Enter' || event.isComposing || event.shiftKey || touch()) return
						submit(event)
					}}
					aria-label="Message"
					placeholder=${() =>
						homeBot(props.thread)
							? `Write to ${homeBot(props.thread).name}`
							: members().names.length
								? `Write to ${listed(members().names)}`
								: 'Pick a model below, then write'}
					value=${() => draft().text}
					onFocus=${() => {
						if (!active()) enter()
					}}
					onPaste=${(event) => {
						const files = imagesIn(event.clipboardData?.items)
						if (!files.length) return
						event.preventDefault()
						add(files)
					}}
					onInput=${(event) => {
						// What it asks stays as it was when the typing started
						if (!pick(props.thread) && !homeBot(props.thread) && !directing(props.thread))
							setPick(
								snapshot(agent(props.thread)),
								snapshot(askedBots(props.thread)),
								props.thread,
								true,
							)
						changeDraft((draft) => {
							draft.text = event.currentTarget.value
						})
						typed(props.thread, event.currentTarget.value)
						findMention()
					}}
				></textarea>
				<${Show} when=${() => active()}>
					<button
						class="primary send"
						title="Send"
						aria-label="Send"
						disabled=${() => draft().sending || (!free() && !whom().length)}
					>
						<${Icon} name="up" />
					</button>
				<//>
			</div>
			<div class="bar">
				<button
					type="button"
					class="ghost small add"
					title="Add images; you can also paste or drop them"
					aria-label="Add images"
					onClick=${(_e) => {
						enter()
						chooser.click()
					}}
				>
					<${Icon} name="plus" />
				</button>
				<input
					type="file"
					accept="image/*"
					multiple
					hidden
					ref=${(el) => (chooser = el)}
					onChange=${(event) => {
						add(imagesIn(event.currentTarget.files))
						event.currentTarget.value = ''
					}}
				/>
				<${Show}
					when=${() => open() && ['working', 'blocked'].includes(threadOf(props.thread)?.status)}
				>
					<button
						type="button"
						class="ghost small stop"
						aria-label="Stop"
						title="Stop this thread"
						disabled=${() => stop.state() === 'busy'}
						onClick=${(_event) => stop()}
					>
						<${Busy} state=${stop.state}>Stop<//>
					</button>
				<//>
				<${Show} when=${() => filled()}>
					<${Popover}
						class="recall"
						button=${() =>
							html`<button
								type="button"
								class="ghost small pick"
								aria-label="Context"
								title="How full the agent's context is"
								onClick=${(_event) => enter()}
							>
								<span>${() => `${filled().share}%, ${Math.round(filled().used / 1000)}k`}</span>
							</button>`}
						ref=${(el) => (recall = el)}
						onToggle=${(event) => {
							// The tape counts the thread's messages from its first, so opening it brings them all
							if (event.newState === 'open') loadEarlier(props.thread, true)
							else setLines(false)
						}}
					>
						<${Show} when=${() => active()}>
							<${Panes}
								title="Context"
								onClose=${(_event) => recall.hidePopover()}
								detailTitle="Memory’s lines"
								open=${() => lines()}
								onBack=${(_event) => setLines(false)}
								detail=${html`<${Show} when=${() => lines()}><${Memory} /><//>`}
							>
								<${Compaction} />
								<${Show} when=${() => server().modules?.includes('memory')}>
									<ul class="rows">
										<li>
											<button type="button" class="row" onClick=${(_event) => setLines(true)}>
												<div>
													<span>Inspect memory</span>
													<small>The lines the agent reads instead of its old messages.</small>
												</div>
												<${Icon} name="next" />
											</button>
										</li>
									</ul>
								<//>
								<button
									type="button"
									class="save"
									disabled=${() => compactNow.state() === 'busy'}
									title=${() =>
										server().modules?.includes('memory')
											? undefined
											: 'Pi summarises the old messages, which costs a model call'}
									onClick=${(_event) => compactNow()}
								>
									<${Show}
										when=${() => compactNow.state() === 'busy'}
										fallback=${html`<${Busy} state=${compactNow.state}>Compact now<//>`}
										>Compacting…<//
									>
								</button>
							<//>
						<//>
					<//>
				<//>
				<${Popover}
					class="model-picker"
					button=${() =>
						html`<button
							type="button"
							class="ghost small pick"
							aria-label=${() =>
								`${asking() ? `Asks ${asking()}` : members().group ? 'Pick someone for one message' : 'Asks no one yet; pick a model'}${folderOf(props.thread) ? ` in ${folderOf(props.thread)}` : ''}`}
							title=${() =>
								(homeBot(props.thread)
									? `The model ${homeBot(props.thread).name} runs as`
									: free()
										? 'The director picks the agent, bots, or nobody; pick one here to choose'
										: whom().map(formatAgent).join(', ')) +
								(folderOf(props.thread) ? `, in ${folderOf(props.thread)}` : '') +
								`. In the box, Shift+Tab cycles thinking, ${mod}+P and Shift+${mod}+P cycle models, ${mod}+L opens this`}
							onClick=${(_event) => enter()}
						>
							<span
								><${Show}
									when=${() => asking() && !free() && whom().length}
									fallback=${() =>
										members().group
											? `${where(props.thread)}pick someone`
											: asking() || 'Pick a model'}
									><${For} each=${() => whom()}
										>${(to, index) => [
											() => (index() ? ' + ' : agent(props.thread) ? where(props.thread) : ''),
											() => recipientWords(to, props.thread)[0],
											html`<${Show} when=${() => recipientWords(to, props.thread)[1]}
												><span class="thinking-word"
													>:${() => recipientWords(to, props.thread)[1]}</span
												><//
											>`,
											html`<${Show} when=${() => !to.name && metered(to.runner, to.model)}
												>${' '}<${Metered}
											/><//>`,
										]}<//
									><//
								></span
							>
						</button>`}
					ref=${(el) => (picker = el)}
					anchor=${() => anchor ?? box}
					end=${() => !anchor}
					onToggle=${(event) => {
						if (event.newState === 'closed') anchor = undefined
					}}
				>
					<${ModelPicker}
						getTo=${(runner) => toFor(runner, props.thread)}
						selectedRunner=${() => agent(props.thread)?.runner}
						fromRunner=${() => ownAgent(props.thread)?.runner}
						onChoose=${(to) => {
							choose(to, true, props.thread)
							picker.hidePopover()
						}}
						onConfigure=${(to) => configure(to, props.thread)}
						onRecipients=${() =>
							homeBot(props.thread)
								? undefined
								: (text) => {
										pickRecipients(text)
										picker.hidePopover()
									}}
						folders=${true}
						checkout=${() => !props.thread}
						onClose=${(_e) => picker.hidePopover()}
						after=${(search) => (homeBot(props.thread) ? null : pickerBots(search))}
					/>
				<//>
			</div>
			<div class="popover model-picker mentions" popover="manual" ref=${(el) => (mentionList = el)}>
				<div class="model-controls">
					<ul
						class="list"
						role="listbox"
						ref=${(el) => (mentionRows = el)}
						aria-label=${() => (mention()?.slash ? 'Skills' : 'Bots and threads to mention')}
					>
						<${For} each=${() => mentionable()} keyed=${(option) => option.key}>
							${(option) =>
								MentionRow(option, {
									pick: () => pickMention(option()),
									note: () =>
										option().bot
											? isHere(option().bot, props.thread)
												? formatAgent(option().bot.to)
												: 'not in this thread yet'
											: option().kind,
								})}
						<//>
					</ul>
				</div>
			</div>
		</form>
	`
}

/** A click asks only the bot; shift-click adds it beside the agent, or takes it off */
function PickerBot(bot, close, thread) {
	const selected = () => askedBots(thread()).some((to) => to.name === bot.name)
	return html`
		<li role="presentation">
			<button
				type="button"
				role="option"
				class="ghost model"
				aria-pressed=${() => String(selected())}
				onClick=${(event) => {
					if (!event.shiftKey) return (setPick(null, [botAgent(bot)], thread()), close())
					const others = askedBots(thread()).filter((to) => to.name !== bot.name)
					setPick(
						snapshot(agent(thread())),
						selected() ? others : [...others, botAgent(bot)],
						thread(),
					)
				}}
			>
				<span style=${() => colorOf(bot.name)}>${() => bot.name}</span>
				<small>${() => formatAgent(bot.to)}</small>
				<${Show} when=${selected}><${Icon} name="check" /><//>
			</button>
		</li>
	`
}

/** An option in the @ and / list: a row like a bot's in the picker, its name and what it is, highlighted by the keys, picked by a tap */
function MentionRow(option, mention) {
	return html`
		<li role="presentation">
			<button
				type="button"
				role="option"
				tabindex="-1"
				class="ghost model"
				onMouseDown=${(event) => event.preventDefault()}
				onClick=${() => mention.pick()}
				title=${() => option().description}
			>
				<span style=${() => (option().bot ? colorOf(option().bot.name) : '')}
					>${() => option().label}</span
				>
				<small>${mention.note}</small>
			</button>
		</li>
	`
}

const [compose, setCompose] = createStore({
	drafts: {},
	picks: {},
	settings: {},
})
/** A draft as this page holds it: `key` is what its message posts under; `restored`, a failed send's text put back */
const emptyDraft = { text: '', images: [], key: '', sending: false }
/**
 * Tells the thread you're typing, so the director's picks wait for you: a beat every 2 s while there's text, one
 * that you stopped once it's empty. Sending ends it on the server.
 */
let beat = { thread: null, at: 0 }
/** Each beat and stop carries a number that only grows, so a late beat never outlives the stop sent after it */
let seq = Date.now()
function typed(thread, text) {
	if (!thread) return
	const typing = Boolean(text.trim())
	if (typing && beat.thread === thread && Date.now() - beat.at < 2000) return
	if (!typing && beat.thread !== thread) return
	beat = typing ? { thread, at: Date.now() } : { thread: null, at: 0 }
	api(`/api/threads/${thread}/typing`, { typing, seq: ++seq }).catch(() => {})
}

/** Each mounted composer's textarea, by thread id ('new' for one with none yet), so a quote from its message list can reach it */
const textareas = new Map()
/** A change to a thread's draft, saved with the `fields` it touched; a new thread's stays on this page */
const changeDraftFor = (key, change, fields = ['text']) => {
	setCompose((store) => {
		store.drafts[key] ??= { ...emptyDraft, images: [] }
		change(store.drafts[key])
		store.drafts[key].key ||= crypto.randomUUID()
	})
	if (fields.length) saveLater(key, fields)
}
/** This page, so it tells its own saves from another device's */
const page = crypto.randomUUID()
/** Each thread's save waiting out the typing: the fields it carries and its timer; what's waiting here wins over the server's */
const saving = new Map()
/** Text goes half a second after the typing pauses; images and a pick at once, being a deliberate act */
function saveLater(thread, fields) {
	const waiting = saving.get(thread) ?? { fields: new Set(), timer: 0 }
	for (const name of fields) waiting.fields.add(name)
	clearTimeout(waiting.timer)
	waiting.timer = setTimeout(() => save(thread), fields.includes('text') ? 500 : 0)
	saving.set(thread, waiting)
}
/** `keepalive` lets a closing page's save go out; it takes small bodies only, so images, saved at once anyway, stay behind */
function save(thread, keepalive = false) {
	const waiting = saving.get(thread)
	const draft = untrack(() => compose.drafts[thread])
	if (!waiting || !draft) return
	cancelSave(thread)
	const chosen = untrack(() => pick(thread))
	const body = {
		key: draft.key,
		page,
		...(waiting.fields.has('text') && { text: draft.text }),
		...(waiting.fields.has('images') && !keepalive && { images: snapshot(draft.images) }),
		...(waiting.fields.has('pick') && {
			pick: chosen && !chosen.held ? snapshot(chosen) : null,
		}),
	}
	if (keepalive) return saveOnClose(thread, body)
	api(draftPath(thread), body)
		.then((answer) => answer.sent && wasSent(thread, body.key, true))
		.catch(() => {})
}
function cancelSave(thread) {
	clearTimeout(saving.get(thread)?.timer)
	saving.delete(thread)
}
/** Sends on their way: `{thread, key, text}` */
const sendingNow = new Set()
const saveOnClose = (thread, body) => {
	void fetch(`${url}${draftPath(thread)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		keepalive: true,
	}).catch(() => {})
}
/**
 * A closing page sends what waits to be saved, and puts each send still on its way back as a draft under its key: if
 * it landed, that save does nothing; if not, the reload finds it in the box and Send posts it once.
 */
addEventListener('pagehide', () => {
	for (const thread of saving.keys()) save(thread, true)
	for (const { thread, key, text } of sendingNow) saveOnClose(thread, { key, text, page })
})
/**
 * A message went under this draft's key, from here or another device: what was sent leaves the box. Text typed here
 * since, which a save found already sent, stays under a new key and saves again; a failed-looking send put back never does.
 */
function wasSent(thread, key, typedHere = false) {
	let kept = false
	setCompose((store) => {
		const draft = store.drafts[thread]
		if (!draft || draft.key !== key) return
		kept =
			(typedHere || saving.has(thread)) &&
			draft.text !== draft.restored &&
			Boolean(draft.text.trim() || draft.images.length)
		if (!kept) Object.assign(draft, { text: '', images: [] })
		draft.key = crypto.randomUUID()
		delete draft.restored
		// A new thread's pick stays for the next one, as the server keeps it
		if (!kept && thread !== 'new' && store.picks[thread] && !store.picks[thread].held)
			delete store.picks[thread]
	})
	if (kept) saveLater(thread, ['text', 'images'])
}
/** Keys this page sent its messages under: a draft read back under one, as a new thread's on its way, is already gone */
const spent = new Set()
/** The draft as the server has it, unless this page has a save waiting, which wins */
function tookDraft(thread, saved) {
	if (saving.has(thread)) return
	// Its text is gone; a new-thread draft's pick stays for the next one
	if (saved && spent.has(saved.key))
		saved = saved.pick ? { key: '', text: '', images: [], pick: saved.pick } : null
	setCompose((store) => {
		const draft = (store.drafts[thread] ??= { ...emptyDraft, images: [] })
		if (draft.sending) return
		Object.assign(draft, {
			text: saved?.text ?? '',
			images: saved?.images ?? [],
			// None saved, or one under no key yet like a new thread's pick left behind, gets a key of its own here: the
			// one this page had may be spent already
			key: saved?.key || crypto.randomUUID(),
		})
		delete draft.restored
		if (saved?.pick) store.picks[thread] = saved.pick
		else if (store.picks[thread] && !store.picks[thread].held) delete store.picks[thread]
	})
}
/** Read, not taken from the feed's first frame, which can predate the save a page closing just before sent */
const loadDraft = (thread) =>
	api(draftPath(thread))
		.then(({ draft }) => tookDraft(thread, draft))
		.catch(() => {})
/** Where a thread's draft is kept; `new`, the one for a thread not started yet */
const draftPath = (thread) => (thread === 'new' ? '/api/draft' : `/api/threads/${thread}/draft`)
/** Each save another page of yours makes to a draft on screen, or its send */
function heardDraft(rows, frame, reset) {
	if (reset) return
	const name = frame.view.slice('draft/'.length)
	const thread = name === 'new' ? name : Number(name)
	const { draft, page: saver, sent } = rows.get('draft')
	if (sent) wasSent(thread, sent)
	else if (saver !== page) tookDraft(thread, draft)
}
/** Each thread's pick, `{agent, bots}`, kept by thread id; a new thread's under `new` */
/** What you chose in a thread's composer, or the new thread's for `null`; none until you choose */
export const pick = (thread = current()) => compose.picks[thread ?? 'new'] ?? null
const here = (thread = current()) => threadOf(thread)?.agents ?? []
const ownAgent = (thread) => here(thread).find((agent) => agent.to && !agent.to.name)?.to
const lastTo = (thread = current()) =>
	(entries[thread] ?? []).findLast((event) => event.data.to?.length)?.data.to
const fallback = (runner) =>
	compose.settings[runner.name] ?? {
		runner: runner.name,
		model: runner.model,
		...(runner.thinkingLevel && { thinkingLevel: runner.thinkingLevel }),
	}
/** Whom the next message asks as the agent: in a bot's home the bot, else the pick, else the thread's agent as it runs */
export const agent = (thread = current()) => {
	const bot = homeBot(thread)
	if (bot) return botAgent(bot)
	const chosen = pick(thread)
	if (chosen) return chosen.agent
	const last = lastTo(thread)
	if (last && !last.some((name) => name.includes('@'))) return null
	const own = ownAgent(thread)
	const first = runners.find((runner) => runner.online) ?? runners[0]
	return own ?? (first?.model ? fallback(first) : null)
}
/** The bots it asks beside it: those picked, or those the thread asked last, as they run */
const askedBots = (thread) => {
	if (homeBot(thread)) return []
	const chosen = pick(thread)
	// Picked before a rename, a bot shows its name now
	if (chosen?.bots)
		return chosen.bots.map((to) => {
			const bot = to.home && bots.find((one) => one.home === to.home)
			return bot ? { ...to, name: bot.name } : to
		})
	const last = lastTo(thread)
	return here(thread)
		.map((agent) => agent.to)
		.filter((to) => to?.name && last?.includes(to.name))
}
const isHere = (bot, thread) =>
	here(thread).some((agent) => agent.to?.name === bot.name) ||
	askedBots(thread).some((to) => to.name === bot.name)
/**
 * What an @ could mention, as options that say what they write, by the start of a bot's name or of any word in a thread's title: bots first, those in the thread
 * before the rest, then other threads once something's typed. A bot's home mentions threads only; archived threads never come.
 */
const mentionsFor = (query, thread) => {
	const typed = query.toLowerCase()
	const starts = (words) => words.toLowerCase().startsWith(typed)
	const matching = homeBot(thread) ? [] : bots.filter((bot) => starts(bot.name))
	const titled = typed
		? threadRows()
				.open.filter(
					(row) => row.id !== thread && row.title && row.title.split(/[^\w.-]+/).some(starts),
				)
				.slice(0, 8)
		: []
	return [
		...matching.filter((bot) => isHere(bot, thread)),
		...matching.filter((bot) => !isHere(bot, thread)),
	]
		.map((bot) => ({
			key: bot.name,
			label: bot.name,
			written: `@${bot.name}`,
			bot,
		}))
		.concat(
			titled.map((row) => ({
				key: `thread-${row.id}`,
				label: row.title,
				written: threadMention(row.title),
				kind: 'thread',
			})),
		)
}
/** Each runner folder's skills, `runner:dir` → [{name, description}], fetched once per page */
const [skills, setSkills] = createStore({})
/** Where the message's agent works: the runner and folder its skills come from */
const workplace = (thread) => {
	const to = recipients(thread)[0]
	return to?.runner && { runner: to.runner, dir: to.dir ?? '' }
}
const loadSkills = (thread) => {
	const at = workplace(thread)
	if (!at || !server().modules?.includes('context')) return
	const key = `${at.runner}:${at.dir}`
	if (key in skills) return
	setSkills((store) => void (store[key] = []))
	api(`/api/context?runner=${encodeURIComponent(at.runner)}&dir=${encodeURIComponent(at.dir)}`)
		.then(({ skills: found }) => setSkills((store) => void (store[key] = found ?? [])))
		.catch(() => setSkills((store) => void delete store[key]))
}
/** The skills a `/` could pick, by the start of their name, for the runner and folder the message goes to */
const skillsFor = (query, thread) => {
	const at = workplace(thread)
	const typed = query.toLowerCase()
	return (skills[at ? `${at.runner}:${at.dir}` : ''] ?? [])
		.filter((skill) => skill.name.toLowerCase().startsWith(typed))
		.map((skill) => ({
			key: `skill-${skill.name}`,
			label: skill.name,
			written: `/skill:${skill.name}`,
			kind: 'skill',
			description: skill.description,
		}))
}
/** A thread with at least two agents/bots: a message whose sender chose no one goes without `to` */
const directing = (thread) => Boolean(thread && here(thread).filter((agent) => agent.to).length > 1)
export const recipients = (thread = current()) =>
	[agent(thread), ...askedBots(thread)].filter(Boolean)
/** A bot by its name, an agent by its model, then its thinking, as `pi --model model:thinking` takes them; the provider only when it bills per use, since that's who charges; the runner is the picker's to show. Without thinking asked, it keeps the running level, or the runner's known pi default. */
const recipientWords = (to, thread) => {
	const running = here(thread).find(
		(agent) =>
			agent.to?.name === to.name && agent.to?.model === to.model && agent.to?.runner === to.runner,
	)?.to
	const runner = runners.find((runner) => runner.name === to.runner)
	const thinkingLevel =
		to.thinkingLevel ?? (running ? running.thinkingLevel : runner?.thinkingLevel)
	if (to.name) return [to.name]
	const model = metered(to.runner, to.model) ? to.model : to.model?.split('/').pop()
	return [model, thinkingLevel]
}
/** The folder the next message's agent works in: as picked, else where it runs now, else its runner's own */
export const folderOf = (thread) => {
	// In a group whose last message asked no agent, the thread's own agent still works where it did
	const to = agent(thread) ?? ownAgent(thread)
	const runner = to && runners.find((runner) => runner.name === to.runner)
	if (!runner?.dir) return
	const running = here(thread).find(
		(agent) => agent.to?.runner === to.runner && agent.to?.name === to.name,
	)?.to
	const dir = to.dir ?? running?.dir
	if (!dir) return runner.dir
	return /^([/\\]|[A-Za-z]:)/.test(dir) ? dir : `${runner.dir}/${dir}`
}
/** Where the agent works, before whom the box asks: `ade/`, or `office:ade/` once more than one runner is online */
/** Names as a sentence lists them: "a", "a and b", "a, b and c", or past three "a, b and 2 others" */
const listed = (names) =>
	names.length <= 3
		? names.length > 1
			? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
			: names[0]
		: `${names.slice(0, 2).join(', ')} and ${names.length - 2} others`
const where = (thread) => {
	const folder = folderOf(thread)?.split(/[\\/]/).filter(Boolean).pop()
	if (!folder) return ''
	const several = runners.filter((runner) => runner.online).length > 1
	const runner = (agent(thread) ?? ownAgent(thread))?.runner
	return `${several ? `${runner}:` : ''}${folder}/ `
}
/** What a runner's controls show: the agent asked, if it runs there, else what was last chosen there */
export const toFor = (runner, thread = current()) => {
	const selected = agent(thread)
	return selected?.runner === runner.name ? selected : fallback(runner)
}
/** `held` marks a pick made only to keep the label still while you type, not one you chose */
const setPick = (to, bots, thread = current(), held = false) => {
	setCompose((store) => {
		store.picks[thread ?? 'new'] = { agent: to, bots, ...(held && { held }) }
		if (to && !to.name) store.settings[to.runner] = to
	})
	// A pick you chose is part of the draft; one held while typing isn't
	if (!held) changeDraftFor(thread ?? 'new', () => {}, ['pick'])
}
/** Choosing a model replaces the agent's pick and keeps the bots; in a bot's home, it is the bot's own model */
export function choose(asked, always = true, thread = current()) {
	const runner = runners.find((runner) => runner.name === asked.runner)
	const thinkingLevel = clampLevel(runner, asked.model, asked.thinkingLevel)
	const to = { ...asked, ...(thinkingLevel && { thinkingLevel }) }
	const bot = homeBot(thread)
	if (bot) return saveBot(bot.name, { to: { ...to, name: undefined } }).catch(report)
	if (always || agent(thread)?.runner === to.runner)
		setPick(to, snapshot(askedBots(thread)), thread)
	else setCompose((store) => void (store.settings[to.runner] = to))
}
/** A runner's settings change the agent's pick only when the agent is on that runner */
export const configure = (to, thread = current()) => choose(to, false, thread)

const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const mod = mac ? 'Cmd' : 'Ctrl'
/** Pi's own keys from its terminal: Shift+Tab cycles thinking, Ctrl+P cycles models and Shift+Ctrl+P back, Ctrl+L opens the picker; Cmd on a Mac */
const piKey = (event) => {
	if (event.isComposing || event.altKey) return
	const held = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
	if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.metaKey) return 'thinking'
	if (held && event.key.toLowerCase() === 'p') return event.shiftKey ? 'previous' : 'next'
	if (held && !event.shiftKey && event.key.toLowerCase() === 'l') return 'picker'
}
/** The runner the keys change, as the picker's foot picks it: the asked agent's, else the first online */
const keyRunner = (thread) =>
	runners.find((runner) => runner.name === agent(thread)?.runner && runner.dir) ??
	runners.find((runner) => runner.online)
/** Thinking one level up among those the model can use, wrapping to the first, from the level the label shows, as the picker's thinking row sets it */
const cycleThinking = (thread) => {
	const runner = keyRunner(thread)
	// A pick of bots alone has no agent whose thinking the label shows
	if (!runner || !agent(thread)) return false
	const to = toFor(runner, thread)
	const running = here(thread).find(
		(agent) => agent.to?.name === to.name && agent.to?.runner === to.runner,
	)?.to
	const now = to.thinkingLevel ?? running?.thinkingLevel ?? runner.thinkingLevel ?? 'off'
	const levels = levelsOf(runner, to.model)
	const next =
		levels.find((level) => THINKING_LEVELS.indexOf(level) > THINKING_LEVELS.indexOf(now)) ??
		levels[0]
	if (next === now) return false
	configure({ ...to, thinkingLevel: next }, thread)
	return true
}
/** The runner's default model, then those its newest threads run, five in all, and the one asked now */
const shortList = (runner, to) => {
	const recent = threadRows()
		.open.flatMap((row) => row.agents ?? [])
		.map((agent) => agent.to)
		.filter((each) => each && !each.name && each.runner === runner.name)
		.map((each) => each.model)
	const list = [...new Set([runner.model, ...recent].filter(Boolean))].slice(0, 5)
	return to.model && !list.includes(to.model) ? [...list, to.model] : list
}
/** The next model on the short list, or the one before, chosen as a tap in the picker chooses it */
const cycleModel = (thread, step) => {
	const runner = keyRunner(thread)
	if (!runner?.online) return false
	const to = toFor(runner, thread)
	const list = shortList(runner, to)
	if (list.length < 2) return false
	const at = list.indexOf(to.model)
	// From none on the list, forward starts at the first and back at the last
	const model = at < 0 ? list.at(step > 0 ? 0 : -1) : list[(at + step + list.length) % list.length]
	choose({ ...to, name: undefined, model }, true, thread)
	return true
}

/** A bot's settings open the current composer's picker, which already edits that bot's agent. */
let lend
export const openPicker = (anchor) => lend?.(anchor)

/**
 * A message's quote button calls this: the selection goes into that thread's draft as `> ` lines, a block of its own below
 * anything already there, with a blank line and the cursor after it, ready to write under it. Quoting again adds another
 * block the same way, so several passages can each get their own comment before sending.
 */
export const appendQuote = (thread, text) => {
	const key = thread ?? 'new'
	// Its lines each after their own `> `, with no blank line at either end
	const block = text
		.replace(/^\s*\n+|\n+\s*$/g, '')
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n')
	if (!block) return
	let full
	changeDraftFor(key, (draft) => {
		const before = draft.text.replace(/\s+$/, '')
		full = `${before ? `${before}\n\n` : ''}${block}\n\n`
		draft.text = full
	})
	const input = textareas.get(key)
	if (!input) return
	input.focus()
	input.value = full
	input.setSelectionRange(full.length, full.length)
}
