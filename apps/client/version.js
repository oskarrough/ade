/**
 * What changed, and the sidebar foot's one line about it: "Update ready" with Restart and What changed when the
 * owner's restart is waiting, "What's new" alone once this browser hasn't looked yet, nothing once it has. Settings
 * keeps the same popover behind its own Version section.
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

/** What changed's popover: a trigger that reads `label`, hidden by `hidden` when the foot shows nothing, and the
 * grouped list once it opens; its panel stays mounted either way, so Jump and Settings can open it through
 * `openVersion` even with nothing to show in the foot. */
function ChangesPopover(props) {
	const [commits, setCommits] = createSignal([])
	const [isNews, setIsNews] = createSignal(false)
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
				class=${() => ['ghost small foot-toggle version-toggle', { hidden: props.hidden }]}
				data-fuzz-skip
				title="What changed"
			>
				${() => props.label}
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

/**
 * The sidebar foot's one line: nothing while there's neither an update nor news, "What's new" alone once this
 * browser hasn't looked at the newest restart, or "Update ready" with Restart and What changed when the owner's
 * restart is waiting. Never both at once.
 */
export function FootNews() {
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
	return html`<div class="foot-news">
		<${Show} when=${updateShown}>
			<span class="mute">Update ready</span>
			<button
				type="button"
				class="ghost small"
				data-fuzz-skip
				disabled=${() => update.state() === 'busy' || Boolean(restarting())}
				title=${title}
				onClick=${(_e) => update()}
			>
				<${Busy} state=${() => (restarting() ? 'busy' : update.state())}>Restart<//>
			</button>
		<//>
		<${ChangesPopover}
			label=${() => (updateShown() ? 'What changed' : "What's new")}
			hidden=${() => !updateShown() && !hasNews()}
		/>
	</div>`
}

/** Version, Settings' own small section: ade's version, the desktop's if there is one, What's new, and Restart
 * when an update is waiting */
export function VersionSection() {
	const update = busy(async () => (restarts() ? restart() : installShellUpdate()))
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
						What’s new
					</button>
				</div>
			</li>
		</ul>
	<//>`
}
