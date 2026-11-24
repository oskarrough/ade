/** The same thread row in the list, its family, and a bot's other threads; with search on, its field above them; its foot opens the inbox, and offers a reload once ade has changed since the page loaded. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { createSignal, For, Show } from 'solid-js'
import {
	archivedThreads,
	archiveThread,
	bots,
	changes,
	current,
	followThread,
	fork,
	homeBot,
	hrefOf,
	waiting,
	api,
	me,
	openInbox,
	openThread,
	page,
	renameThread,
	restart,
	restarting,
	runners,
	server,
	threadOf,
	threadRows,
} from './server.js'
import { Dot } from './dot.js'
import { Popover } from './popover.js'
import { Panes } from './panes.js'
import { liveOf } from './agent.js'
import { report } from './notice.js'
import { EditInPlace } from './edit-in-place.js'
import { busy } from './busy.js'
import { copyText, installShellUpdate, nativeMenu, shellUpdate } from './desktop.js'
import { openSide } from './side.js'
import { RunnerList } from './runner.js'
import { openTaskForm, ScheduledTaskList } from './schedule.js'
import { Settings } from './settings.js'
import { BotItem, NewBot } from './bot.js'
import { SearchField } from './search.js'
import { cards, HoverCard, HoverFrame } from './hover-card.js'

/** Whether New bot's name field shows at the top of the bots; jump.js opens it too */
export const [creatingBot, setCreatingBot] = createSignal(false)

/** Whether the Archived page has the list's place; New bot from Jump leaves it */
export const [archivedPage, setArchivedPage] = createSignal(false)

export function ThreadList() {
	/** Most recently answered first, anywhere, not only at home; a bot that's never answered sits last, oldest-made first */
	const sortedBots = () =>
		bots.toSorted((a, b) =>
			a.answeredAt && b.answeredAt
				? a.answeredAt < b.answeredAt
					? 1
					: -1
				: a.answeredAt
					? -1
					: b.answeredAt
						? 1
						: a.home - b.home,
		)
	return html`
		<nav class="thread-list" aria-label="Threads">
			<${HoverFrame} />
			<${Show}
				when=${() => !archivedPage()}
				fallback=${html`<${ArchivedPage} onBack=${(_e) => setArchivedPage(false)} />`}
			>
				<ul class="top-row">
					<${Show} when=${() => server().modules.includes('search')}>
						<${SearchField} />
					<//>
					<${NewRow}
						label="Thread"
						title="New thread"
						current=${() => page().kind === 'threads' && !current()}
						onPick=${(_e) => openThread(null)}
					/>
					<${Show} when=${() => server().modules.includes('bots')}>
						<${NewRow} label="Bot" title="New bot" onPick=${(_e) => setCreatingBot(true)} />
					<//>
				</ul>
				<${Show} when=${() => server().modules.includes('inbox')}>
					<ul class="inbox-row">
						<li
							class=${() => ['new', { current: page().kind === 'inbox', waiting: waiting().length > 0 }]}
						>
							<button
								type="button"
								class="row"
								title="Show what needs your attention"
								aria-pressed=${() => String(page().kind === 'inbox')}
								aria-label=${() => (waiting().length ? `Inbox, ${waiting().length}` : 'Inbox')}
								onClick=${(_e) => {
									setArchivedPage(false)
									if (page().kind === 'inbox') openThread(current())
									else openInbox()
								}}
							>
								<span class="plus" aria-hidden="true"></span>
								Inbox
								<${Show} when=${() => waiting().length}
									><small aria-hidden="true">${() => waiting().length}</small><//
								>
							</button>
						</li>
					</ul>
				<//>
				<${Show} when=${() => server().modules.includes('bots')}>
					<h2>Bots</h2>
					<ul class="bots">
						<${Show} when=${() => creatingBot()}
							><${NewBot} onDone=${(_e) => setCreatingBot(false)}
						/><//>
						<${For} each=${sortedBots}>${(bot) => html`<${BotItem} bot=${() => bot} />`}<//>
					</ul>
					<h2>Threads</h2>
				<//>
				<ul>
					<${For}
						each=${() =>
							threadRows()
								.open.filter((row) => !homeBot(row.id) && !threadOf(row.parent))
								.map((row) => threadOf(row.id))
								.filter(Boolean)}
					>
						${(thread) => html`<${ThreadItem} thread=${() => thread} />`}
					<//>
					<${Show} when=${() => archivedThreads.length}>
						<li class="new">
							<button type="button" class="row" onClick=${() => setArchivedPage(true)}>
								<span class="plus" aria-hidden="true"></span>
								Archived
								<small aria-hidden="true">${() => archivedThreads.length}</small>
							</button>
						</li>
					<//>
				</ul>
			<//>
			<${GetApp} />
			<footer class="list-foot">
				<${Settings} />
				<${RunnerList} />
				<${Show} when=${() => server().modules.includes('schedule')}><${ScheduledTaskList} /><//>
				<${Update} />
			</footer>
		</nav>
	`
}

/**
 * Update, when ade needs more than the reload a page does by itself: the owner's restarts a server whose code changed,
 * or that has a newer release staged, and the page reloads once it's back; in arbe desktop, a newer app opens its
 * update window. Up to date, it's a quiet line naming the version, which opens what changed.
 */
function Update() {
	const restarts = () =>
		(server().stale || server().staged) &&
		server().settings?.restarts &&
		me() === server().settings.owner
	const shown = () => restarts() || shellUpdate()
	const update = busy(async () => (restarts() ? restart() : installShellUpdate()))
	const title = () => {
		if (!restarts()) return `arbe desktop ${shellUpdate()} is out`
		if (server().staged)
			return `ade ${server().staged} is ready: ade restarts into it and the page reloads`
		return (
			changes()
				.map((commit) => commit.subject)
				.join('\n') ||
			'The server changed since it started: it restarts, as Save and restart does, and the page reloads once it’s back'
		)
	}
	return html`<${Show} when=${shown} fallback=${html`<${Version} />`}>
		<button
			type="button"
			class="ghost small foot-toggle update-toggle"
			data-fuzz-skip
			disabled=${() => update.state() === 'busy' || Boolean(restarting())}
			title=${title}
			onClick=${(_e) => update()}
		>
			<span>Update</span>
		</button>
	<//>`
}

/** 24 Nov, with the year when it isn't this one */
const dayOfCommit = (at) => {
	const date = new Date(at)
	return date.toLocaleDateString('en-GB', {
		day: 'numeric',
		month: 'short',
		...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
	})
}

/** The checkout's commit and its newest twenty subjects, or the installed release and its notes; nothing for an install
 * that names neither */
function Version() {
	let panel
	const [commits, setCommits] = createSignal([])
	const version = () => server().release ?? server().commit?.slice(0, 7)
	return html`<${Show} when=${version}>
		<${Popover}
			class="version-list"
			button=${() =>
				html`<button
					type="button"
					class="ghost small foot-toggle version-toggle"
					title=${() =>
						server().release
							? `Up to date. What changed in ${version()}`
							: 'Up to date. What changed lately'}
				>
					<span>${version}</span>
				</button>`}
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState === 'open')
					api('/api/changes').then(({ commits }) => setCommits(commits), report)
			}}
		>
			<${Panes} title="What changed" open=${() => false} onClose=${(_event) => panel.hidePopover()}>
				<ul class="rows">
					<${For} each=${commits}>
						${(commit) =>
							html`<li>
								<div>
									<span>${() => commit.subject}</span>
									<small>${() => (commit.at ? dayOfCommit(commit.at) : '')}</small>
								</div>
							</li>`}
					<//>
				</ul>
			<//>
		<//>
	<//>`
}

const LATEST = 'https://github.com/oskarrough/ade/releases/latest/download/'
const HIDE_APP = 'ade.hideGetApp'
/** The app for this computer: an installer, a disk image, or on Linux the line that installs it where it updates itself */
const app = (() => {
	const platform = /** @type {any} */ (navigator).userAgentData?.platform ?? navigator.platform
	if (/^Win/i.test(platform)) return { os: 'Windows', href: `${LATEST}arbe-desktop-windows.exe` }
	if (/^Mac/i.test(platform) && navigator.maxTouchPoints < 2)
		return { os: 'macOS', href: `${LATEST}arbe-desktop-mac.dmg` }
	if (/Linux/i.test(platform) && !/Android/i.test(navigator.userAgent))
		return { os: 'Linux', command: `curl -fsSL ${LATEST}install.sh | sh` }
})()

/** A quiet line above a browser's sidebar foot, never in arbe desktop: its card shows the app and one download */
function GetApp() {
	const [hidden, setHidden] = createSignal(localStorage.getItem(HIDE_APP) === '1')
	const [copied, setCopied] = createSignal(false)
	const shown = () => app && cards && !(/** @type {any} */ (window).mygo) && !hidden()
	return html`<${Show} when=${shown}>
		<div class="get-app">
			<button type="button" class="ghost small">
				<${Icon} name="download" />
				<span>Get the app</span>
			</button>
			<${HoverCard}
				class="app-card"
				content=${() => html`
					<img
						src="/icons/app.png"
						alt="arbe desktop, a thread and its sidebar"
						width="640"
						height="400"
					/>
					<${Show}
						when=${() => app.href}
						fallback=${html`<button
							type="button"
							class="primary"
							title=${app.command}
							onClick=${() => copyText(app.command).then(() => setCopied(true), report)}
						>
							${() => (copied() ? 'Copied; paste it in a terminal' : 'Copy the install line for Linux')}
						</button>`}
					>
						<button type="button" class="primary" onClick=${() => location.assign(app.href)}>
							Download for ${app.os}
						</button>
					<//>
					<button
						type="button"
						class="ghost small"
						onClick=${() => {
							localStorage.setItem(HIDE_APP, '1')
							setHidden(true)
						}}
					>
						Don’t show again
					</button>
				`}
			/>
		</div>
	<//>`
}

function ArchivedPage(props) {
	return html`
		<header class="page-head">
			<button
				type="button"
				class="ghost small"
				aria-label="Back to threads"
				onClick=${() => props.onBack()}
			>
				<${Icon} name="back" />
			</button>
			<h2>Archived</h2>
		</header>
		<ul class="thread-family">
			<${For} each=${() => archivedThreads}>
				${(thread) => html`<${ThreadItem} thread=${() => thread} archived />`}
			<//>
		</ul>
	`
}

function NewRow(props) {
	return html`
		<li class=${() => ['new', { current: props.current }]}>
			<button
				type="button"
				class="row"
				title=${() => props.title}
				aria-label=${() => props.title}
				onClick=${() => props.onPick()}
			>
				<span class="plus" aria-hidden="true"><${Icon} name="plus" /></span>
				<span>${() => props.label}</span>
			</button>
		</li>
	`
}

/** A thread's right-click menu in arbe desktop: used by thread rows and the thread header pill. A row passes its own onRename to edit itself in place; without one, Rename opens the thread details and focuses its title field there. */
export const threadMenu = (id, { archived = false, open = true, onRename } = {}) => {
	const paused = !!threadOf(id)?.paused
	return [
		open && { label: 'Open', run: () => openThread(id) },
		{ label: 'Rename…', run: onRename ?? (() => rename(id)) },
		// The details' Regenerate: the model writes a new title, over one set by hand too
		server().modules.includes('auto-title') &&
			!homeBot(id) && {
				label: 'Regenerate title',
				run: () => api(`/api/threads/${id}/auto-title`, {}),
			},
		{
			label: 'Fork',
			run: async () => {
				const { entries } = await api(`/api/threads/${id}?last=1`)
				const last = entries.at(-1)
				if (last) await fork(id, last.id)
			},
		},
		{
			label: 'Copy link',
			run: () => copyText(new URL(hrefOf(id), location.href).href),
		},
		server().modules.includes('schedule') && {
			label: 'Schedule a task…',
			run: () => openTaskForm(id),
		},
		!archived && {
			label: paused ? 'Resume' : 'Pause',
			run: () => api(`/api/threads/${id}/pause`, { paused: !paused }),
		},
		...(homeBot(id)
			? []
			: [
					null,
					{
						label: archived ? 'Unarchive' : 'Archive',
						run: () => archiveThread(id, !archived),
					},
				]),
	]
}
/** Opens the thread with its details, its title or bot name field ready to type in */
export const rename = (id) => {
	openThread(id)
	openSide(id, 'details')
	const label = homeBot(id) ? 'Bot name' : 'Thread title'
	requestAnimationFrame(() => {
		const field = document.querySelector(`input[aria-label="${label}"]`)
		if (!(field instanceof HTMLInputElement)) return
		field.focus()
		field.select()
	})
}

export function ThreadItem(props) {
	/** Whether this row's own title is open for editing, right where it sits; the row keeps its size either way */
	const [editing, setEditing] = createSignal(false)
	return html`
		<li
			title=${() => (cards ? undefined : props.thread.title)}
			style=${() => `--depth: ${props.depth ?? 0}`}
			class=${() => ({
				current: page().kind === 'threads' && props.thread.id === current(),
				archived: props.archived,
			})}
		>
			<a
				class="row"
				href=${() => hrefOf(props.thread.id)}
				onClick=${(event) => (editing() ? event.preventDefault() : followThread(event, props.thread.id))}
				onContextMenu=${(event) =>
					nativeMenu(
						event,
						threadMenu(props.thread.id, {
							archived: props.archived,
							onRename: () => setEditing(true),
						}),
					)}
			>
				<${Dot} state=${() => props.thread.status} />
				<${Show} when=${editing} fallback=${html`<span>${() => props.thread.title}</span>`}>
					<${EditInPlace}
						class="bare"
						aria-label="Thread title"
						title="Rename this thread"
						focused
						value=${() => props.thread.title}
						onSave=${(next) => renameThread(props.thread.id, next)}
						onDone=${() => setEditing(false)}
					/>
				<//>
			</a>
			<${Show} when=${() => !editing()}>
				<${HoverCard} content=${() => html`<${ThreadCard} thread=${() => props.thread} />`} />
			<//>
			<${Show} when=${() => !homeBot(props.thread.id) && !editing()}>
				<button
					type="button"
					class="small archive"
					title=${() => (props.archived ? 'Bring this thread back' : 'Archive this thread')}
					onClick=${() => archiveThread(props.thread.id, !props.archived).catch(report)}
				>
					${() => (props.archived ? 'Unarchive' : 'Archive')}
				</button>
			<//>
		</li>
	`
}

const homeShort = (dir) => dir.replace(/^\/(home|Users)\/[^/]+/, '~')

/** Where an agent works: its folder, under its runner's own when relative */
const workingIn = (to) => {
	const root = runners.find((runner) => runner.name === to.runner)?.dir
	const dir = to.dir ?? root
	if (!dir) return
	return homeShort(/^([/\\]|[A-Za-z]:)/.test(dir) || !root ? dir : `${root}/${dir}`)
}

/** A thread's title and what it's doing now; then each agent's model on its runner, the folder they work in, and the thread it sits under */
function ThreadCard(props) {
	const agents = () => props.thread.agents.filter((agent) => agent.to)
	const parent = () => threadOf(props.thread.parent)
	return html`
		<p class="title">${() => props.thread.title}</p>
		<p class="live">
			<${Dot} state=${() => props.thread.status} />
			<span>${() => liveOf(props.thread)}</span>
		</p>
		<${For} each=${agents}>
			${(agent) =>
				html`<small>
					${() =>
						agent.to.name ??
						[
							agent.to.model?.split('/').pop(),
							agent.to.thinkingLevel !== 'off' && agent.to.thinkingLevel,
						]
							.filter(Boolean)
							.join(' ')}
					on ${() => agent.to.runner}
				</small>`}
		<//>
		<${For}
			each=${() => [
				...new Set(
					agents()
						.map((agent) => workingIn(agent.to))
						.filter(Boolean),
				),
			]}
		>
			${(folder) => html`<small>${folder}</small>`}
		<//>
		<${Show} when=${parent}>
			<small>Under ${() => parent().title}</small>
		<//>
	`
}
