/** The same thread row in the list, its family, and a bot's other threads; its foot opens the inbox, and offers a reload once ade has changed since the page loaded. */
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
	homeBot,
	hrefOf,
	inbox,
	inboxOpen,
	openInbox,
	openThread,
	server,
	threadOf,
	threadRows,
} from './server.js'
import { Dot } from './dot.js'
import { report } from './notice.js'
import { RunnerList } from './runner.js'
import { Settings } from './settings.js'
import { BotItem, NewBot } from './bot.js'

export function ThreadList() {
	const [creating, setCreating] = createSignal(false)
	const [archivedPage, setArchivedPage] = createSignal(false)
	/** Most recently answered first, anywhere, not only at home; a bot that's never answered sits last, oldest-made first */
	const sortedBots = () =>
		[...bots].sort((a, b) =>
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
				<ul class="new-rows">
					<${NewRow}
						label="Thread"
						title="New thread"
						current=${() => !current() && !inboxOpen()}
						onPick=${(_e) => openThread(null)}
					/>
					<${Show} when=${() => server().modules.includes('bots')}>
						<${NewRow} label="Bot" title="New bot" onPick=${(_e) => setCreating(true)} />
					<//>
				</ul>
				<${Show} when=${() => server().modules.includes('inbox')}>
					<${Counted}
						word="Inbox"
						count=${() => inbox.length}
						pressed=${inboxOpen}
						onClick=${(_e) => {
							setArchivedPage(false)
							if (inboxOpen()) openThread(current())
							else openInbox()
						}}
					/>
				<//>
				<${Show} when=${() => server().modules.includes('bots')}>
					<h2>Bots</h2>
					<ul class="bots">
						<${Show} when=${() => creating()}><${NewBot} onDone=${(_e) => setCreating(false)} /><//>
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
								<span>Archived</span>
								<small aria-hidden="true">${() => archivedThreads.length}</small>
							</button>
						</li>
					<//>
				</ul>
			<//>
			<footer class="list-foot">
				<${Settings} />
				<${RunnerList} />
				<${Show} when=${behind}>
					<button
						type="button"
						class="ghost small foot-toggle"
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

/** A foot toggle whose count sits beside its word, like an unread count; with some, its word goes ink */
function Counted(props) {
	return html`
		<button
			type="button"
			class=${() => ['ghost small foot-toggle inbox-toggle', { some: props.count }]}
			aria-pressed=${() => String(props.pressed)}
			aria-label=${() => (props.count ? `${props.word}, ${props.count}` : props.word)}
			onClick=${(event) => props.onClick(event)}
		>
			<span>${() => props.word}</span>
			<${Show} when=${() => props.count}
				><small class="count" aria-hidden="true">${() => props.count}</small><//
			>
		</button>
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
