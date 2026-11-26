/** Settings' People, the owner's alone: invites on or off, an invite's link, who holds one and the runners they added,
 * and the owner link that brings another device in */
import html from '@solidjs/html'
import { createSignal, For, Show } from 'solid-js'
import { api, runners, write } from './server.js'
import { Switch } from './dot.js'
import { Sure } from './sure.js'
import { busy, Busy } from './busy.js'
import { report } from './notice.js'
import { tidyName } from './runner.js'

const [invited, setInvited] = createSignal(/** @type {{name: string, at: string}[]} */ ([]))
/** Who holds an invite, asked again each time Settings opens */
export const loadInvites = () =>
	api('/api/invites')
		.then(({ invites }) => setInvited(invites))
		.catch(report)
/** The last link made here, {name, link}: an invite's key is shown once, so it's gone when Settings closes */
const [shown, setShown] = createSignal(null)
export const forgetLink = () => setShown(null)

export function People(props) {
	const [name, setName] = createSignal('')
	const [error, setError] = createSignal('')
	const [copied, setCopied] = createSignal(false)
	const show = (made) => {
		setShown(made)
		setCopied(false)
	}
	const add = busy(
		async () => {
			setError('')
			const { name: who, link } = await write('/api/invites', { name: name().trim() })
			show({ name: who, link })
			setName('')
			await loadInvites()
		},
		{ onError: (failure) => setError(failure.message) },
	)
	const ownerLink = busy(async () => show({ name: '', link: (await api('/api/link', {})).link }))
	const copy = () =>
		navigator.clipboard
			.writeText(shown().link)
			.then(() => setCopied(true))
			.catch(report)
	return html`
		<h3>People</h3>
		<ul class="rows modules people">
			<li class=${() => ({ off: !props.on, open: true })}>
				<div class="about">
					<span>Invites</span>
					<small
						>With invites on, everyone needs an invite, tailnet friends included, and invited people
						can use every runner in the house, yours included.</small
					>
				</div>
				<${Switch}
					on=${() => props.on}
					title=${() => `Invites: ${props.on ? 'on' : 'off'}`}
					disabled=${() => props.disabled}
					onToggle=${(_on) => props.onToggle()}
				/>
			</li>
			<${For} each=${invited}>${(person) => html`<${Person} person=${() => person} />`}<//>
		</ul>
		<div class="connect-runner invite">
			<form
				onSubmit=${(event) => {
					event.preventDefault()
					add()
				}}
			>
				<input
					aria-label="Who to invite"
					placeholder="a name, like sam"
					spellcheck="false"
					autocomplete="off"
					required
					value=${() => name()}
					onInput=${(event) => setName(tidyName(event.currentTarget))}
				/>
				<button
					type="submit"
					disabled=${() => add.state() === 'busy'}
					aria-busy=${() => add.state() === 'busy'}
				>
					<${Busy} state=${add.state}
						>${() =>
							invited().some((person) => person.name === name().trim()) ? 'New link' : 'Invite'}<//
					>
				</button>
			</form>
			<${Show} when=${() => error()}><p class="bad">${() => error()}</p><//>
			<${Show} when=${shown}>
				<p class="mute">
					${() =>
						shown().name
							? `Send ${shown().name} this link; it brings their browser in as ${shown().name}. It’s shown once.`
							: 'Open this on your other device; it comes in as you. Keep it to yourself.'}
				</p>
				<div class="command">
					<pre>${() => shown().link}</pre>
					<button type="button" class="small" onClick=${(_event) => copy()}>
						${() => (copied() ? 'Copied' : 'Copy')}
					</button>
				</div>
				<${Show} when=${() => shown().name && !props.on}>
					<p class="mute">Invites are off, so it opens nothing until you turn them on.</p>
				<//>
			<//>
		</div>
		<ul class="rows people">
			<li>
				<div>
					<span>Your other devices</span>
					<small
						>Through Tailscale they read as you; to write, or while invites are on, they need your
						key: a link brings one in as you.</small
					>
				</div>
				<button
					type="button"
					class="small"
					disabled=${() => ownerLink.state() === 'busy'}
					onClick=${(_event) => ownerLink()}
				>
					<${Busy} state=${ownerLink.state}>Open on another device<//>
				</button>
			</li>
		</ul>
	`
}

function Person(props) {
	const theirs = () =>
		runners.filter((runner) => runner.by === props.person.name).map((runner) => runner.name)
	const remove = busy(async () => {
		await write(`/api/invites/${encodeURIComponent(props.person.name)}`, undefined, 'DELETE')
		if (shown()?.name === props.person.name) setShown(null)
		await loadInvites()
	})
	return html`
		<li>
			<div>
				<span>${() => props.person.name}</span>
				<small
					>${() =>
						theirs().length
							? `Added ${theirs().join(', ')}`
							: `Invited ${new Date(props.person.at).toLocaleDateString()}`}</small
				>
			</div>
			<${Sure}
				class="small revoke"
				title="Put them out: their link opens nothing from their next request, and their runners go offline"
				ask="remove?"
				disabled=${() => remove.state() === 'busy'}
				onConfirm=${(_event) => remove()}
				><${Busy} state=${remove.state}>Remove<//><//
			>
		</li>
	`
}
