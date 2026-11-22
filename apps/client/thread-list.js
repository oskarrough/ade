/** The same thread row in the list, its family, and a bot's other threads; with search on, its field above them; its foot opens the inbox, and offers a reload once ade has changed since the page loaded. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { createSignal, For, Show } from 'solid-js'
import {
	archivedThreads,
	archiveThread,
	behind,
	bots,
	changes,
	current,
	followThread,
	fork,
	homeBot,
	hrefOf,
	inbox,
	inboxOpen,
	api,
	openInbox,
	openThread,
	searchFor,
	server,
	threadOf,
	threadRows,
} from './server.js'
import { Dot } from './dot.js'
import { report } from './notice.js'
import { copyText, nativeMenu } from './desktop.js'
import { openSide } from './side.js'
import { RunnerList } from './runner.js'
import { openTaskForm, ScheduledTaskList } from './schedule.js'
import { Settings } from './settings.js'
import { BotItem, NewBot } from './bot.js'
import { SearchField } from './search.js'

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
						current=${() => !current() && !inboxOpen() && searchFor() === null}
						onPick=${(_e) => openThread(null)}
					/>
					<${Show} when=${() => server().modules.includes('bots')}>
						<${NewRow} label="Bot" title="New bot" onPick=${(_e) => setCreatingBot(true)} />
					<//>
				</ul>
				<${Show} when=${() => server().modules.includes('inbox')}>
					<ul class="inbox-row">
						<li class=${() => ['new', { current: inboxOpen(), waiting: inbox.length > 0 }]}>
							<button
								type="button"
								class="row"
								title="Show what needs your attention"
								aria-pressed=${() => String(inboxOpen())}
								aria-label=${() => (inbox.length ? `Inbox, ${inbox.length}` : 'Inbox')}
								onClick=${(_e) => {
									setArchivedPage(false)
									if (inboxOpen()) openThread(current())
									else openInbox()
								}}
							>
								<span class="plus" aria-hidden="true"></span>
								Inbox
								<${Show} when=${() => inbox.length}
									><small aria-hidden="true">${() => inbox.length}</small><//
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
			<footer class="list-foot">
				<${Settings} />
				<${RunnerList} />
				<${Show} when=${() => server().modules.includes('schedule')}><${ScheduledTaskList} /><//>
				<${Show} when=${behind}>
					<button
						type="button"
						class="ghost small foot-toggle update-toggle"
						aria-label=${() =>
							changes().length ? `Update, ${changes().length} commits` : 'Update'}
						title=${() =>
							changes().join('\n') ||
							'ade changed since this page loaded; reloading keeps your thread and draft'}
						onClick=${(_e) => location.reload()}
					>
						<span>Update</span>
						<${Show} when=${() => changes().length}
							><small class="count" aria-hidden="true">${() => changes().length}</small><//
						>
					</button>
				<//>
			</footer>
		</nav>
	`
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

/** A thread's right-click menu in arbe desktop: used by thread rows and the thread header pill */
export const threadMenu = (id, { archived = false, open = true } = {}) => {
	const paused = !!threadOf(id)?.paused
	return [
		open && { label: 'Open', run: () => openThread(id) },
		{ label: 'Rename…', run: () => rename(id) },
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
		{ label: 'Copy link', run: () => copyText(new URL(hrefOf(id), location.href).href) },
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
					{ label: archived ? 'Unarchive' : 'Archive', run: () => archiveThread(id, !archived) },
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
	return html`
		<li
			title=${() => props.thread.title}
			style=${() => `--depth: ${props.depth ?? 0}`}
			class=${() => ({ current: props.thread.id === current() })}
		>
			<a
				class="row"
				href=${() => hrefOf(props.thread.id)}
				onClick=${(event) => followThread(event, props.thread.id)}
				onContextMenu=${(event) =>
					nativeMenu(event, threadMenu(props.thread.id, { archived: props.archived }))}
			>
				<${Dot} state=${() => props.thread.status} />
				<span>${() => props.thread.title}</span>
			</a>
			<${Show} when=${() => !homeBot(props.thread.id)}>
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
