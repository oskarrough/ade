/** The same thread row in the list, its family, and a bot's other threads. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { createSignal, For, Show } from 'solid-js'
import {
	archivedThreads,
	archiveThread,
	bots,
	current,
	followThread,
	homeBot,
	hrefOf,
	openThread,
	server,
	threads,
} from './server.js'
import { Dot } from './dot.js'
import { report } from './notice.js'
import { RunnerList } from './runner.js'
import { Settings } from './settings.js'
import { BotItem, NewBot } from './bot.js'

export function ThreadList() {
	const [creating, setCreating] = createSignal(false)
	const [archivedPage, setArchivedPage] = createSignal(false)
	const [blockedOnly, setBlockedOnly] = createSignal(false)
	const blocked = () =>
		threads.filter((thread) => !thread.archived && thread.status === 'blocked').length
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
						label="New thread"
						current=${() => !current()}
						onPick=${(_e) => openThread(null)}
					/>
					<${Show} when=${() => server().modules.includes('bots')}>
						<${NewRow} label="New bot" onPick=${(_e) => setCreating(true)} />
					<//>
				</ul>
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
							threads.filter(
								(thread) =>
									!thread.archived &&
									(blockedOnly()
										? thread.status === 'blocked'
										: !homeBot(thread.id) && !threads.some((other) => other.id === thread.parent)),
							)}
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
				<${Show} when=${() => server().modules.includes('blocked')}>
					<button
						type="button"
						class=${() => ['ghost small foot-toggle blocked-toggle', { some: blocked() }]}
						aria-pressed=${() => String(blockedOnly())}
						aria-label=${() => (blocked() ? `Blocked, ${blocked()}` : 'Blocked')}
						onClick=${() => {
							setArchivedPage(false)
							setBlockedOnly((value) => !value)
						}}
					>
						<span>Blocked</span>
						<${Show} when=${() => blocked()}
							><small class="count" aria-hidden="true">${() => blocked()}</small><//
						>
					</button>
				<//>
				<${RunnerList} />
				<${Settings} />
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
			<button type="button" class="row" onClick=${() => props.onPick()}>
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
