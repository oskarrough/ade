/**
 * What changed, and the sidebar foot's one item about it: "Update" when the owner's restart is waiting, "What's new"
 * once this browser hasn't looked yet, nothing once it has. Either opens What changed, which carries Restart while an
 * update waits. Settings keeps the same popover behind its own Version section.
 */
import html from '@solidjs/html'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { api, changes, me, restart, restarting, server } from './server.js'
import { Popover } from './popover.js'
import { Panes } from './panes.js'
import { report } from './notice.js'
import { busy, Busy } from './busy.js'
import { desktopVersion, installShellUpdate, shellUpdate } from './desktop.js'

const REPO = 'https://github.com/oskarrough/ade'
/** This browser's newest version seen: a device's state, like the sidebar width, not a person's */
const SEEN_VERSION = 'ade.seenVersion'
/** A commit that changes nothing a person would notice says so; those fold into one line per group */
const INTERNAL = /nothing changes for you/i

/** The checkout's commit or the installed release's tag; null for an install that names neither */
export const version = () => server().release ?? server().commit
/** `version`, shortened to a commit's first seven characters; a release's tag is already short */
export const shortVersion = () => server().release ?? server().commit?.slice(0, 7)
/** Where the running version lives in the source: a commit's page on a checkout, a release's on an install */
const sourceHref = () =>
	server().release
		? `${REPO}/releases/tag/${server().release}`
		: server().commit && `${REPO}/commit/${server().commit}`

/** Whether the owner's restart is waiting: a server whose code changed, or that has a newer release staged; in arbe
 * desktop, a newer app */
const restarts = () =>
	(server().stale || server().staged) &&
	server().settings?.restarts &&
	me() === server().settings.owner
export const updateShown = () => restarts() || Boolean(shellUpdate())

const [seen, setSeen] = createSignal(localStorage.getItem(SEEN_VERSION))
/** Whether a restart brought a version newer than the one this browser last looked at; a checkout pulled but not
 * yet restarted isn't running its news */
export const hasNews = () => {
	const v = version()
	return Boolean(v) && !server().stale && seen() !== null && seen() !== v
}
const markSeen = () => {
	const v = version()
	if (v && seen() !== v) {
		localStorage.setItem(SEEN_VERSION, v)
		setSeen(v)
	}
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

/** Commits grouped by day, or as one group under the release's tag on an installed copy; each group's commits that
 * say nothing changes for the person fold into one count, the rest kept in order */
const groupChanges = (commits, release) => {
	const groups = []
	let open
	for (const commit of commits) {
		const label = release ?? dayOfCommit(commit.at)
		if (!open || open.label !== label) {
			open = { label, items: [], folded: 0 }
			groups.push(open)
		}
		if (INTERNAL.test(commit.subject)) open.folded++
		else open.items.push(commit)
	}
	return groups
}

let panel
/** Opens What changed from anywhere: Jump, Settings, or the foot's own line */
export const openVersion = () => panel?.showPopover()

/** Restart into the waiting update: the server's own restart, or arbe desktop's install */
function restartUpdate() {
	return busy(async () => (restarts() ? restart() : installShellUpdate()))
}
const restartTitle = () => {
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

/**
 * The sidebar foot's one item and the What changed popover behind it: "Update" while the owner's restart is waiting,
 * with Restart in the popover's head; "What's new" once this browser hasn't looked at the newest restart; nothing
 * otherwise. Its panel stays mounted either way, so Jump and Settings can open it through `openVersion`.
 */
export function FootNews() {
	const [commits, setCommits] = createSignal([])
	const [isNews, setIsNews] = createSignal(false)
	const update = restartUpdate()
	const groups = () => groupChanges(commits(), server().release)
	// The first version this browser ever sees is read as caught up, not as news
	createEffect(version, (v) => {
		if (v && seen() === null) markSeen()
	})
	// Nor is a restart that brought only internal changes
	createEffect(hasNews, (news) => {
		if (!news) return
		const since = server().release ? null : seen()
		api(`/api/changes${since ? `?since=${since}` : ''}`).then(
			({ commits }) => commits.every((commit) => INTERNAL.test(commit.subject)) && markSeen(),
			() => {},
		)
	})
	return html`<${Popover}
		class="version-list"
		button=${() =>
			html`<button
				type="button"
				class=${() => [
					'ghost small foot-toggle version-toggle',
					{ hidden: !updateShown() && !hasNews() },
				]}
				data-fuzz-skip
				title=${() => (updateShown() ? 'An update is waiting' : 'What changed')}
			>
				<span>${() => (updateShown() ? 'Update' : "What's new")}</span>
			</button>`}
		ref=${(el) => (panel = el)}
		onToggle=${(event) => {
			if (event.newState === 'open') {
				const since = !server().release && hasNews() ? seen() : null
				setIsNews(hasNews())
				api(`/api/changes${since ? `?since=${since}` : ''}`).then(
					({ commits }) => setCommits(commits),
					report,
				)
			} else markSeen()
		}}
	>
		<${Panes}
			title="What changed"
			actions=${html`<${Show} when=${updateShown}>
				<button
					type="button"
					class="small"
					data-fuzz-skip
					disabled=${() => update.state() === 'busy' || Boolean(restarting())}
					title=${restartTitle}
					onClick=${(_e) => update()}
				>
					<${Busy} state=${() => (restarting() ? 'busy' : update.state())}>Restart<//>
				</button>
			<//>`}
			foot=${html`<p class="mute">
				<${Show} when=${version}
					><a href=${sourceHref} target="_blank" rel="noopener noreferrer"
						>ade ${shortVersion}</a
					><//
				>${() => (version() && desktopVersion() ? ', ' : '')}${() =>
					desktopVersion() ? `arbe desktop ${desktopVersion()}` : ''}
			</p>`}
			open=${() => false}
			onClose=${(_event) => panel.hidePopover()}
		>
			<ul class="rows change-groups">
				<${For} each=${groups}>
					${(group) =>
						html`<li class="group">
							<h4>${() => group.label}</h4>
							<ul class="rows">
								<${For} each=${() => group.items}>
									${(commit) =>
										html`<li class=${() => ({ new: isNews() })}>
											<span>${() => commit.subject}</span>
										</li>`}
								<//>
								<${Show} when=${() => group.folded > 0}>
									<li class="mute folded">
										plus ${() => group.folded} internal
										change${() => (group.folded === 1 ? '' : 's')}
									</li>
								<//>
							</ul>
						</li>`}
				<//>
			</ul>
		<//>
	<//>`
}

/** Version, Settings' own small section: ade's version, the desktop's if there is one, What's new, and Restart
 * when an update is waiting */
export function VersionSection() {
	const update = restartUpdate()
	return html`<${Show} when=${() => version() || desktopVersion()}>
		<h3>Version</h3>
		<ul class="rows version-section">
			<li>
				<div>
					<${Show} when=${version}
						><span
							>ade
							<a href=${sourceHref} target="_blank" rel="noopener noreferrer"
								>${shortVersion}</a
							></span
						><//
					>
					<${Show} when=${desktopVersion}><span>arbe desktop ${desktopVersion}</span><//>
				</div>
				<div class="actions">
					<${Show} when=${updateShown}>
						<button
							type="button"
							class="ghost small"
							data-fuzz-skip
							disabled=${() => update.state() === 'busy' || Boolean(restarting())}
							onClick=${(_e) => update()}
						>
							<${Busy} state=${() => (restarting() ? 'busy' : update.state())}>Restart<//>
						</button>
					<//>
					<button type="button" class="ghost small" onClick=${(_e) => openVersion()}>
						${() => (hasNews() ? 'What’s new' : 'What changed')}
					</button>
				</div>
			</li>
		</ul>
	<//>`
}
