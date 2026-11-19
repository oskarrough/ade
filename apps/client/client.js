/** Just the chat, or the live system around it. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import { render } from '@solidjs/web'
import { createEffect, Errored, Loading, onSettled, Show } from 'solid-js'
import {
	chat,
	colorOf,
	current,
	drawer,
	homeBot,
	params,
	setChat,
	titleOf,
	threadOf,
} from './server.js'
import { sideOf, toggleSide } from './side.js'
import { Dot } from './dot.js'
import { System } from './system.js'
import { Tutorial } from './tutorial.js'

function Client() {
	document.body.classList.toggle('grid', params.has('grid'))
	createEffect(chat, (on) => {
		document.body.classList.toggle('chat', on)
		drawer(null)
		const next = new URL(location.href)
		if (on) next.searchParams.set('chat', '')
		else next.searchParams.delete('chat')
		history.replaceState(null, '', next)
		dispatchEvent(new Event('resize'))
	})
	onSettled(() => {
		const close = (event) => {
			if (event.key === 'Escape') drawer(null)
		}
		const resize = () => drawer(null)
		const phone = matchMedia('(max-width: 700px)')
		// iOS Safari ignores interactive-widget: the keyboard shrinks only the visual viewport, so the stage follows that.
		const viewport = window.visualViewport
		const fit = () => {
			document.documentElement.style.setProperty('--visual-height', `${viewport.height}px`)
			// offsetTop also goes nonzero as iOS nudges the page while you type with the keyboard open, not only when
			// pinch-zoomed; undoing a pinch-zoom pan is the point, so only scroll back when actually zoomed, or every
			// keystroke's nudge snaps the whole page to the top.
			if (viewport.scale !== 1) scrollTo(0, 0)
		}
		// An installed app on iOS sometimes misses the resize as the keyboard slides in, so focus follows the viewport until it holds still.
		let settling = 0
		const settle = () => {
			cancelAnimationFrame(settling)
			let last = -1
			let still = 0
			let frames = 0
			const step = () => {
				fit()
				still = viewport.height === last ? still + 1 : 0
				last = viewport.height
				if (still < 10 && ++frames < 120) settling = requestAnimationFrame(step)
			}
			step()
		}
		viewport?.addEventListener('resize', fit)
		viewport?.addEventListener('scroll', fit)
		if (viewport) addEventListener('focusin', settle)
		if (viewport) addEventListener('focusout', settle)
		addEventListener('keydown', close)
		phone.addEventListener('change', resize)
		return () => {
			removeEventListener('keydown', close)
			viewport?.removeEventListener('resize', fit)
			viewport?.removeEventListener('scroll', fit)
			removeEventListener('focusin', settle)
			removeEventListener('focusout', settle)
			cancelAnimationFrame(settling)
			phone.removeEventListener('change', resize)
		}
	})
	return html`
		<${Show} when=${() => !chat()}>
			<button class="ghost small mode-toggle" type="button" onClick=${() => setChat(true)}>
				Just the chat
			</button>
		<//>
		<${Errored}
			fallback=${(error, retry) => html`
				<p class="mute">${() => String(error())} <button onClick=${retry}>Retry</button></p>
			`}
		>
			<${Loading}>
				<header class="app-bar">
					<button type="button" aria-label="All threads" onClick=${() => drawer('list')}>
						<${Icon} name="back" />
					</button>
					<button
						class="ghost thread-name"
						type="button"
						aria-pressed=${() => String(sideOf(current())?.key === 'details')}
						style=${() => colorOf(homeBot(current())?.name ?? '')}
						onClick=${() => toggleSide(current(), 'details')}
					>
						<${Dot} state=${() => threadOf(current())?.status} />
						<span>${() => (current() ? titleOf(current()) : 'New thread')}</span>
					</button>
				</header>
				<${System} />
				<${Tutorial} story=${() => !chat()} />
			<//>
		<//>
	`
}

render(Client, document.getElementById('stage'))
