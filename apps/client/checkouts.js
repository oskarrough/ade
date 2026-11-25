/** A new thread's choice of the main checkout or its own, and in a thread's details, which one it works in (the checkouts module). */
import html from '@solidjs/html'
import { createEffect, createSignal, Show } from 'solid-js'
import { api, feedItem, newThreadCheckout, server, setNewThreadCheckout } from './server.js'

const WORDS = { jj: 'jj workspace', git: 'git worktree' }

/** Under the picker's folder, for a thread about to start in a repo: the folder itself, or a checkout of its own */
export function CheckoutChoice(props) {
	const [kind, setKind] = createSignal(/** @type {string | null} */ (null))
	createEffect(
		() =>
			server().modules.includes('checkouts')
				? { runner: props.runner, dir: props.dir ?? '' }
				: null,
		(asked) => {
			setKind(null)
			if (!asked) return
			let current = true
			// A folder outside any repo has no checkouts to choose between
			const answer = (found) => {
				if (!current) return
				setKind(found)
				if (!found) setNewThreadCheckout(false)
			}
			api(`/api/checkouts?${new URLSearchParams(asked)}`).then(
				(found) => answer(found.kind),
				() => answer(null),
			)
			return () => (current = false)
		},
	)
	return html`<${Show} when=${kind}>
		<h3>Checkout</h3>
		<div class="thinking">
			<button
				type="button"
				class="ghost small"
				title="Work in the folder itself, with whatever else works there"
				aria-pressed=${() => String(!newThreadCheckout())}
				onClick=${() => setNewThreadCheckout(false)}
			>
				Main
			</button>
			<button
				type="button"
				class="ghost small"
				title=${() =>
					`A ${WORDS[kind()]} of its own, named after the thread, so its edits stay apart; archiving removes it if it's clean`}
				aria-pressed=${() => String(newThreadCheckout())}
				onClick=${() => setNewThreadCheckout(true)}
			>
				Its own
			</button>
		</div>
	<//>`
}

/** In a thread's details: the checkout of its own it works in, where it started, and what archiving did with it */
export function CheckoutDetails(props) {
	const checkout = feedItem(() => `checkout/${props.thread}`)
	const state = () => {
		const { state, note, branch, tip } = checkout()
		if (state === 'planned') return 'Made when its agent first runs.'
		if (state === 'removing') return 'Being removed, now the thread is archived.'
		if (state === 'removed')
			return `Removed when archived; ${branch ? `branch ${branch}` : `its commits, up to ${tip},`} kept. Its next message makes it again.`
		if (state === 'kept') return `Kept when archived: ${note}.`
		return branch ? `On branch ${branch}.` : ''
	}
	return html`<${Show} when=${checkout}>
		<h3>Checkout</h3>
		<p class="folder" title=${() => checkout().path}>
			${() => `Its own ${WORDS[checkout().kind]}${checkout().parent ? `, from ${checkout().parent}` : ''}.`}
			${' '}${state}
		</p>
	<//>`
}
