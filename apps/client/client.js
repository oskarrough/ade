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
	waiting,
	page,
	params,
	server,
	setChat,
	titleOf,
	threadOf,
} from './server.js'
import { sideOf, toggleSide } from './side.js'
import { Dot } from './dot.js'
import { System } from './system.js'
import { Tutorial } from './tutorial.js'
import { storyDiagram } from './mermaid.js'
import { Jump, openJump } from './jump.js'

function Client() {
	document.body.classList.toggle('grid', params.has('grid'))
	createEffect(chat, (on) => {
		document.body.classList.toggle('chat', on)
		if (!on) void storyDiagram()
		drawer(null)
		const next = new URL(location.href)
		if (on) next.searchParams.delete('story')
		else next.searchParams.set('story', '')
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
		// Safari pans the visual viewport inside the still-full-height layout viewport, both to keep a focused field
		// above the keyboard and when pinch-zoomed; our own --visual-height already keeps the composer above the
		// keyboard, so that pan only fights it, and must be undone. Undo it once per real pan, not on every
		// steady-state resize/scroll tick while typing, which just re-reports the pan already undone and would
		// otherwise snap the whole page to the top on every keystroke.
		let pannedTo = 0
		const fit = () => {
			document.documentElement.style.setProperty('--visual-height', `${viewport.height}px`)
			if (viewport.offsetTop && viewport.offsetTop !== pannedTo) scrollTo(0, 0)
			pannedTo = viewport.offsetTop
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
						onClick=${() => page().kind === 'threads' && toggleSide(current(), 'details')}
					>
						<${Dot} state=${() => (page().kind === 'threads' ? threadOf(current())?.status : '')} />
						<span
							>${() => {
								const here = page()
								if (here.kind === 'inbox')
									return `Inbox${waiting().length ? ` ${waiting().length}` : ''}`
								if (here.kind === 'search') return `Search: ${here.query}`
								if (here.kind === 'usage') return 'Usage'
								return current() ? titleOf(current()) : 'New thread'
							}}</span
						>
					</button>
					<${Show} when=${() => server().modules.includes('jump')}>
						<button type="button" aria-label="Jump to…" onClick=${() => openJump()}>
							<${Icon} name="search" />
						</button>
					<//>
				</header>
				<${System} />
				<${Show} when=${() => server().modules.includes('jump')}><${Jump} /><//>
				<${Tutorial} story=${() => !chat()} />
			<//>
		<//>
	`
}

render(Client, document.getElementById('stage'))
