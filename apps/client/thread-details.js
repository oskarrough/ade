/** Details and tools for the thread on screen, or the one about to start. */
import html from '@solidjs/html'
import { createMemo, createSignal, For, Show } from 'solid-js'
import { Icon } from './icons.js'
import { Panes } from './panes.js'
import { openSide, PageTabs } from './side.js'
import {
	api,
	archiveThread,
	pauseThread,
	colorOf,
	family,
	familyOf,
	forkedFrom,
	homeBot,
	inbox,
	newThreadTools,
	people,
	renameThread,
	server,
	setNewThreadTools,
	threadOf,
	titleOf,
} from './server.js'
import { formatAgent, shortLabel } from './agent.js'
import { BotSettings, botThreads, ForgetBot } from './bot.js'
import { ThreadItem } from './thread-list.js'
import { Switch } from './dot.js'
import { PiSource } from './pi-sessions.js'
import { ThreadUsage } from './usage.js'
import { ThreadTasks } from './schedule.js'
import { agent, folderOf, openPicker } from './composer.js'
import { EditInPlace } from './edit-in-place.js'
import { Sure } from './sure.js'
import { Busy, busy } from './busy.js'
import { CheckoutDetails } from './checkouts.js'

/** A thread that's live whatever its inbox says: running, waiting on a person, or failed */
const LIVE = ['working', 'blocked', 'error']

/**
 * A thread's details as a page of the side column, the same four parts for a thread and a bot's home: its threads,
 * its scheduled tasks, then its settings and usage folded away. A bot's settings add the bot's own; its threads open
 * over the page.
 */
export function DetailsPage(props) {
	const id = () => props.id
	const here = () => threadOf(id())
	const bot = () => homeBot(id())
	const archive = busy(() => archiveThread(id(), !here()?.archived))
	// A bot's home is named for it already, so only who else is there; each once, as an ask's line names them
	const members = () => [
		...new Map(
			[...(people[id()] ?? []), ...(here()?.agents ?? []).map((agent) => agent.name)]
				.filter((name) => name !== bot()?.name)
				.map((name) => [shortLabel(name), name]),
		).values(),
	]
	/** Each family member's depth, read once for every row */
	const depths = createMemo(() => new Map(familyOf(id()).map((one) => [one.id, one.depth])))
	const depth = (member) => depths().get(member) ?? 0
	const parentOf = (member) => {
		const thread = threadOf(member)
		return thread?.parent ?? forkedFrom(thread)
	}
	/**
	 * The thread's own line of descent: ancestors up to the root, itself, and its own descendants.
	 * No siblings or cousins. A root thread's line is still every one of its children.
	 */
	const lineage = () => {
		const ids = family()
		if (!ids.includes(id())) return ids
		const ancestors = new Set()
		for (let above = parentOf(id()); ids.includes(above); above = parentOf(above))
			ancestors.add(above)
		const descendants = new Set()
		const open = [id()]
		while (open.length) {
			const parent = open.pop()
			for (const child of ids)
				if (!descendants.has(child) && parentOf(child) === parent) {
					descendants.add(child)
					open.push(child)
				}
		}
		return ids.filter(
			(member) => member === id() || ancestors.has(member) || descendants.has(member),
		)
	}
	// A bot's threads are a page of their own: a bot with hundreds of them must not push the rest off the page
	const [page, setPage] = createSignal(false)
	const botFamily = createMemo(() => (bot() ? botThreads(bot()) : { own: [], elsewhere: [] }))
	/** Every thread around this one: the bot's, or the thread's own line without itself */
	const others = createMemo(() =>
		bot()
			? [...botFamily().own, ...botFamily().elsewhere]
			: lineage()
					.filter((member) => member !== id())
					.map(threadOf)
					.filter(Boolean),
	)
	/** The inbox's own say on what's unread: only answers you'd read, not the hundreds agents gave each other, which a thread's status counts too. Without an inbox, the status stands. */
	const unread = (thread) =>
		server().modules.includes('inbox')
			? inbox.some((item) => item.kind !== 'question' && item.thread === thread.id)
			: thread.status === 'done'
	/** The newest first */
	const byLatest = (a, b) => b.latest - a.latest
	/** Only what's live: working on top, then the rest by latest activity; the others wait behind All threads */
	const live = createMemo(() =>
		others()
			.filter((thread) => LIVE.includes(thread.status) || unread(thread))
			.sort(
				(a, b) => Number(b.status === 'working') - Number(a.status === 'working') || byLatest(a, b),
			),
	)
	/** All threads, by latest activity */
	const allByLatest = (threads) => [...threads].sort(byLatest)
	const scheduling = () => server().modules.includes('schedule')
	return html`
		<aside class="side thread-details" aria-label="Thread details">
			<${Panes}
				title=${() => (id() ? titleOf(id()) : 'New thread')}
				head=${html`<${PageTabs} id=${id()} />`}
				onClose=${(_event) => openSide(id(), null)}
				open=${page}
				onBack=${(_event) => setPage(false)}
				detailTitle="Threads"
				detail=${() =>
					html`<${Show}
						when=${bot}
						fallback=${html`<ul class="thread-family">
							<${For} each=${() => lineage().map(threadOf).filter(Boolean)}>
								${(thread) =>
									html`<${ThreadItem} thread=${() => thread} depth=${() => depth(thread.id)} />`}
							<//>
						</ul>`}
					>
						<ul class="thread-family">
							<${For} each=${() => allByLatest(botFamily().own)}
								>${(thread) =>
									html`<${ThreadItem}
										thread=${() => thread}
										depth=${() => depth(thread.id) - 1}
									/>`}<//
							>
						</ul>
						<${Show} when=${() => botFamily().elsewhere.length}>
							<h2>Also in</h2>
							<ul class="thread-family">
								<${For} each=${() => allByLatest(botFamily().elsewhere)}
									>${(thread) => html`<${ThreadItem} thread=${() => thread} />`}<//
								>
							</ul>
						<//>
					<//>`}
			>
				<${Show}
					when=${id}
					fallback=${html`<h2>New thread</h2>
						<${Tools} />`}
				>
					<${Show} when=${() => server().modules.includes('pi-sessions')}>
						<${PiSource} thread=${id()} />
					<//>
					<${Show} when=${() => others().length}>
						<h2>Threads</h2>
						<ul class="thread-family">
							<${For} each=${live}>${(thread) => html`<${ThreadItem} thread=${() => thread} />`}<//>
							<li class="new">
								<button
									type="button"
									class="row"
									aria-label=${() =>
										`All ${others().length} ${others().length === 1 ? 'thread' : 'threads'}`}
									onClick=${(_event) => setPage(true)}
								>
									<span class="plus" aria-hidden="true"></span>
									All threads
									<small aria-hidden="true">${() => others().length}</small>
								</button>
							</li>
						</ul>
					<//>
					<${Show} when=${scheduling}>
						<h2>Scheduled</h2>
						<${ThreadTasks} thread=${id()} />
					<//>
					<details class="fold">
						<summary><h2>Settings</h2></summary>
						<${Show} when=${() => !bot()}><${Title} thread=${id()} /><//>
						<${Show} when=${() => members().length > 1}>
							<h3>In this thread</h3>
							<p id="members">
								<${For} each=${() => members()}>
									${(name, index) => [
										() => (index() ? ', ' : ''),
										html`<span title=${() => name} style=${() => colorOf(name)}
											>${() => shortLabel(name)}</span
										>`,
									]}
								<//>
							</p>
						<//>
						<${Show}
							when=${bot}
							keyed
							fallback=${html`<h3>Model</h3>
								<button
									type="button"
									class="thread-model"
									title="Who the next message asks, and how hard it thinks"
									onClick=${(event) => openPicker(event.currentTarget)}
								>
									${() => (agent(id()) ? formatAgent(agent(id())) : 'Pick a model')}
								</button>`}
							>${(found) => html`<${BotSettings} bot=${() => found} />`}<//
						>
						<h3>Folder</h3>
						<p class="folder" title="Where its agent works; the model picker moves it">
							${() => folderOf(id()) ?? 'Its runner’s own'}
						</p>
						<${Show} when=${() => server().modules.includes('checkouts')}>
							<${CheckoutDetails} thread=${id()} />
						<//>
						<h3>Tools</h3>
						<${Tools} thread=${id()} />
						<${Show} when=${() => !bot()}>
							<${Sure}
								class="archive"
								title=${() =>
									here()?.archived ? 'Bring this thread back' : 'Move it out of the list'}
								disabled=${() => archive.state() === 'busy'}
								onConfirm=${(_event) => archive()}
								><${Busy} state=${archive.state}
									>${() => (here()?.archived ? 'Unarchive this thread' : 'Archive this thread')}<//
								><//
							>
						<//>
						<${Show} when=${bot} keyed>${(found) => html`<${ForgetBot} bot=${() => found} />`}<//>
					</details>
					<${Show} when=${() => server().modules.includes('usage')}>
						<${ThreadUsage} thread=${id()} />
					<//>
				<//>
			<//>
		</aside>
	`
}

function Title(props) {
	const title = () => threadOf(props.thread)?.title ?? ''
	// The model writes a new one, and the request answers once it's written or why it wasn't; till then the button turns
	const [failed, setFailed] = createSignal('')
	const regenerate = busy(
		() => {
			setFailed('')
			return api(`/api/threads/${props.thread}/auto-title`, {})
		},
		{ onError: (failure) => setFailed(`No new title: ${failure.message}`) },
	)
	const asking = () => regenerate.state() === 'busy'
	return html`<h2 class="thread-title">
			<${EditInPlace}
				class="bare"
				aria-label="Thread title"
				title="Rename this thread"
				value=${title}
				onSave=${(next) => renameThread(props.thread, next)}
			/>
			<${Show} when=${() => server().modules.includes('auto-title') && !homeBot(props.thread)}>
				<button
					type="button"
					class="ghost small"
					aria-label=${() => (asking() ? 'Writing a new title' : 'New title')}
					title=${() => (asking() ? 'Writing a new title…' : 'Ask the model for a new title')}
					disabled=${asking}
					onClick=${(_event) => regenerate()}
				>
					<${Busy} state=${regenerate.state}><${Icon} name="again" /><//>
				</button>
			<//>
		</h2>
		<${Show} when=${failed}>
			<small class="title-failed" role="alert">${failed}</small>
		<//>`
}

function Tools(props) {
	const tools = () => (props.thread ? threadOf(props.thread)?.tools : newThreadTools())
	const save = (path, body) => api(`/api/threads/${props.thread}/${path}`, body)
	const apply = (list) => {
		const tools = list?.length ? list : null
		if (props.thread) return save('tools', { tools })
		setNewThreadTools(tools)
	}
	const here = () => props.thread && threadOf(props.thread)
	return html`
		<div class="hands">
			<${Switch}
				on=${() => !!tools()}
				title="Its agents can look things up, but every change has to go through a thread"
				onToggle=${(on) => apply(on ? HANDS_OFF : null)}
				><span>Hands off</span><//
			>
			<${EditInPlace}
				placeholder="every tool"
				aria-label="Thread tools"
				spellcheck="false"
				class="tools"
				title="tools, as pi --tools takes them: read,post or -write,-edit,-bash"
				value=${() => (tools() ?? []).join(',')}
				onSave=${(next) => apply(next.split(/[\s,]+/).filter(Boolean))}
			/>
		</div>
		<${Show} when=${() => here()}>
			<div class="hands">
				<${Switch}
					on=${() => !!here().paused}
					title="Only @mentions and named recipients get an answer; replies already on their way finish"
					onToggle=${(on) => pauseThread(props.thread, on)}
					><span>Paused</span><//
				>
			</div>
		<//>
		<${Show} when=${() => typeof here()?.memory === 'boolean'}>
			<div class="hands">
				<${Switch}
					on=${() => here().memory}
					title="Memory writes a line for each message, so its agents remember the whole thread"
					onToggle=${(on) => save('memory', { on })}
					><span>Memory</span><//
				>
			</div>
		<//>
	`
}

const HANDS_OFF = ['-write', '-edit', '-bash']
