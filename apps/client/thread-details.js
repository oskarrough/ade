/** Details and tools for the thread on screen, or the one about to start. */
import html from '@solidjs/html'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Icon } from './icons.js'
import { Panes } from './panes.js'
import { openSide, PageTabs } from './side.js'
import {
	api,
	archiveThread,
	colorOf,
	family,
	familyOf,
	forkedFrom,
	homeBot,
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
import { Dot, Switch } from './dot.js'
import { PiSource } from './pi-sessions.js'
import { ThreadUsage } from './usage.js'
import { ThreadTasks } from './schedule.js'
import { agent, folderOf, openPicker } from './composer.js'
import { report } from './notice.js'
import { Sure } from './sure.js'

/** Thread states that come first in a bot's threads: running, waiting, failed, or answered and unread */
const LIVE = ['working', 'blocked', 'error', 'done']

/**
 * A thread's details as a page of the side column, the same four parts for a thread and a bot's home: its threads,
 * its scheduled tasks, then its settings and usage folded away. A bot's settings add the bot's own; its threads open
 * over the page.
 */
export function DetailsPage(props) {
	const id = () => props.id
	const here = () => threadOf(id())
	const bot = () => homeBot(id())
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
	const botAll = createMemo(() => [...botFamily().own, ...botFamily().elsewhere])
	const live = createMemo(() => botAll().filter((thread) => LIVE.includes(thread.status)))
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
				detail=${html`<ul class="thread-family">
						<${For} each=${() => botFamily().own}
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
							<${For} each=${() => botFamily().elsewhere}
								>${(thread) => html`<${ThreadItem} thread=${() => thread} />`}<//
							>
						</ul>
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
					<${Show}
						when=${bot}
						fallback=${html`<${Show} when=${() => lineage().length > 1}>
							<h2>Threads</h2>
							<ul class="thread-family">
								<${For} each=${() => lineage().map(threadOf).filter(Boolean)}>
									${(thread) =>
										html`<${ThreadItem} thread=${() => thread} depth=${() => depth(thread.id)} />`}
								<//>
							</ul>
						<//>`}
					>
						<${Show} when=${() => botAll().length}>
							<h2>Threads</h2>
							<ul class="thread-family">
								<${For} each=${live}
									>${(thread) => html`<${ThreadItem} thread=${() => thread} />`}<//
								>
								<li class="new">
									<button
										type="button"
										class="row"
										aria-label=${() =>
											`All ${botAll().length} ${botAll().length === 1 ? 'thread' : 'threads'}`}
										onClick=${(_event) => setPage(true)}
									>
										<span class="plus" aria-hidden="true"></span>
										All threads
										<small aria-hidden="true">${() => botAll().length}</small>
									</button>
								</li>
							</ul>
						<//>
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
						<h3>Tools</h3>
						<${Tools} thread=${id()} />
						<${Show} when=${() => !bot()}>
							<${Sure}
								class="archive"
								title=${() =>
									here()?.archived ? 'Bring this thread back' : 'Move it out of the list'}
								onConfirm=${(_event) => archiveThread(id(), !here()?.archived).catch(report)}
								>${() => (here()?.archived ? 'Unarchive this thread' : 'Archive this thread')}<//
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
	const [error, setError] = createSignal('')
	const save = async (field) => {
		const next = field.value.trim()
		if (next === title()) return
		setError('')
		try {
			await renameThread(props.thread, next)
		} catch (failure) {
			setError(failure.message)
			field.value = title()
		}
	}
	// The model writes a new one, and the request answers once it's written or why it wasn't; till then the button blinks
	const [asking, setAsking] = createSignal(false)
	const [failed, setFailed] = createSignal('')
	const regenerate = async () => {
		setError('')
		setFailed('')
		setAsking(true)
		try {
			await api(`/api/threads/${props.thread}/auto-title`, {})
		} catch (failure) {
			setFailed(`No new title: ${failure.message}`)
		} finally {
			setAsking(false)
		}
	}
	return html`<h2 class="thread-title">
			<input
				class=${() => ['bare', { bad: !!error() }]}
				aria-label="Thread title"
				title=${() => error() || 'Rename this thread'}
				value=${title}
				onChange=${(event) => save(event.currentTarget)}
				onKeyDown=${(event) => {
					if (event.key === 'Enter') event.currentTarget.blur()
					if (event.key === 'Escape') {
						event.currentTarget.value = title()
						event.currentTarget.blur()
					}
				}}
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
					<${Show} when=${asking} fallback=${html`<${Icon} name="again" />`}>
						<${Dot} state="working" />
					<//>
				</button>
			<//>
		</h2>
		<${Show} when=${failed}>
			<small class="title-failed" role="alert">${failed}</small>
		<//>`
}

function Tools(props) {
	const tools = () => (props.thread ? threadOf(props.thread)?.tools : newThreadTools())
	let field
	const [text, setText] = createSignal('')
	createEffect(
		() => (tools() ?? []).join(','),
		(value) => {
			if (document.activeElement !== field) setText(value)
		},
	)
	const [error, setError] = createSignal('')
	const save = async (path, body) => {
		setError('')
		try {
			await api(`/api/threads/${props.thread}/${path}`, body)
		} catch (failure) {
			setError(failure.message)
		}
	}
	const apply = (list) => {
		const tools = list?.length ? list : null
		if (props.thread) return save('tools', { tools })
		setError('')
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
			<input
				placeholder="every tool"
				aria-label="Thread tools"
				ref=${(el) => {
					field = el
				}}
				spellcheck="false"
				class=${() => ['tools', { bad: !!error() }]}
				title=${() => error() || 'tools, as pi --tools takes them: read,post or -write,-edit,-bash'}
				value=${() => text()}
				onInput=${(event) => setText(event.currentTarget.value)}
				onChange=${() =>
					apply(
						text()
							.split(/[\s,]+/)
							.filter(Boolean),
					)}
				onKeyDown=${(event) => {
					if (event.key === 'Enter') event.currentTarget.blur()
				}}
			/>
		</div>
		<${Show} when=${() => here()}>
			<div class="hands">
				<${Switch}
					on=${() => !!here().paused}
					title="Only @mentions and named recipients get an answer; replies already on their way finish"
					onToggle=${(on) => save('pause', { paused: on })}
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
