/** Starts a thread from a pi session in one of a runner's folders (settings' pi-sessions row opens it); and, in a thread's details, says which one it came from. */
import html from '@solidjs/html'
import { createSignal, createUniqueId, For, Show } from 'solid-js'
import { api, openThread, runners } from './server.js'
import { report } from './notice.js'
import { EditInPlace } from './edit-in-place.js'

/** A folder and its pi sessions; picking one starts a thread from it and calls `onStarted`. `onLoaded` hears the list change height. */
export function PiSessionList(props) {
	const id = createUniqueId()
	const [where, setWhere] = createSignal('')
	const [found, setFound] = createSignal([])
	const [error, setError] = createSignal('')
	const [starting, setStarting] = createSignal('')
	/** Each folder an online runner offers, as `runner` and `dir` */
	const places = () =>
		runners
			.filter((runner) => runner.online)
			.flatMap((runner) =>
				(runner.folders?.length ? runner.folders : [runner.dir]).map((dir) => ({
					runner: runner.name,
					dir,
				})),
			)
	/** `runner:dir` or a bare dir on the first online runner: any folder there, the offered ones only suggested */
	const placeOf = (text) => {
		const typed = text.trim()
		if (!typed) return places()[0]
		const at = typed.indexOf(':')
		const named = at > 0 && runners.find((runner) => runner.name === typed.slice(0, at))
		return named
			? { runner: named.name, dir: typed.slice(at + 1) }
			: places()[0] && { runner: places()[0].runner, dir: typed }
	}
	const place = () => placeOf(where())
	const said = (candidate) => `${candidate.runner}:${candidate.dir}`
	/** `asked` comes in directly, as a signal set in the same event still reads its old value */
	const load = async (asked = place()) => {
		setError('')
		setFound([])
		if (!asked) return
		// An answer for a folder since left behind is dropped
		const current = () => JSON.stringify(place()) === JSON.stringify(asked)
		try {
			const sessions = await api(`/api/pi-sessions?${new URLSearchParams(asked)}`)
			if (current()) setFound(sessions)
		} catch (failure) {
			if (current()) setError(failure.message)
		}
		props.onLoaded?.()
	}
	const start = async (session) => {
		setStarting(session.path)
		try {
			const { id: thread } = await api('/api/pi-sessions', {
				...place(),
				session: session.path,
			})
			openThread(thread)
			props.onStarted?.()
		} catch (failure) {
			report(failure)
		} finally {
			setStarting('')
		}
	}
	load()
	return html`
		<div class="pi-sessions">
			<${EditInPlace}
				aria-label="Folder"
				list=${`${id}-folders`}
				value=${() => (place() ? said(place()) : '')}
				onSave=${(next) => {
					setWhere(next)
					load(placeOf(next))
				}}
			/>
			<datalist id=${`${id}-folders`}>
				<${For} each=${places}
					>${(candidate) => html`<option value=${() => said(candidate)}></option>`}<//
				>
			</datalist>
			<${Show} when=${() => error()}><p class="bad">${() => error()}</p><//>
			<${Show} when=${() => !error() && !found().length}
				><p class="mute">No pi sessions in this folder.</p><//
			>
			<ul class="rows">
				<${For} each=${found}
					>${(session) => html`
						<li
							role="button"
							tabindex="0"
							title=${() => session.firstMessage}
							onClick=${() => !starting() && start(session)}
							onKeyDown=${(event) => event.key === 'Enter' && !starting() && start(session)}
						>
							<div>
								<span class="first"
									>${() => session.name || session.firstMessage || session.id}</span
								>
								<${Show}
									when=${() => session.lastMessage && session.lastMessage !== session.firstMessage}
									><span class="last">${() => session.lastMessage}</span><//
								>
								<small
									>${() =>
										starting() === session.path
											? 'Starting a thread…'
											: `${session.messageCount} messages, ${new Date(session.modified).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}</small
								>
							</div>
						</li>
					`}<//
				>
			</ul>
		</div>
	`
}

/** Where an imported thread came from, in its details; nothing for any other thread */
export function PiSource(props) {
	const [from, setFrom] = createSignal(null)
	api(`/api/threads/${props.thread}/pi-sessions`)
		.then((found) => setFrom(found.from))
		.catch(() => {})
	return html`
		<${Show} when=${from}>
			<h2>From pi</h2>
			<p class="mute" title=${() => from().file}>${() => `${from().name}, on ${from().runner}`}</p>
		<//>
	`
}
