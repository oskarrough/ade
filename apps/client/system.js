/** The client, server, threads and runners, with the routes between them. */
import html from '@solidjs/html'
import { createMemo, For, onSettled, Show } from 'solid-js'
import {
	columns,
	connected,
	current,
	inboxOpen,
	runners,
	searchFor,
	usageOpen,
	server,
	threadOf,
	url,
} from './server.js'
import { Inbox } from './inbox.js'
import { Search } from './search.js'
import { rowOf } from './agent.js'
import { recipients } from './composer.js'
import { Dot } from './dot.js'
import { Runner } from './runner.js'
import { Thread } from './thread.js'
import { Canvas } from './canvas.js'
import { Recap } from './recap.js'
import { Director } from './director.js'
import { sideOf } from './side.js'
import { DetailsPage } from './thread-details.js'
import { ThreadList } from './thread-list.js'
import { Wires } from './wires.js'
import { QuoteButton } from './quote.js'
import { Usage } from './usage.js'

const SIDE_PAGES = { canvas: Canvas, director: Director, recap: Recap }

export function System() {
	const searching = () => searchFor() !== null && server().modules.includes('search')
	const showingUsage = () => usageOpen() && server().modules.includes('usage')
	const shown = createMemo(() => columns().map(threadOf).filter(Boolean))
	const agents = createMemo(() =>
		shown().flatMap((thread) => thread.agents.map((agent) => ({ ...agent, thread: thread.id }))),
	)
	const connections = createMemo(() => {
		const asking = recipients()
		const down = { fromSide: 'bottom', toSide: 'top', fromAt: 'to' }
		const row = (to) =>
			`[data-runner="${CSS.escape(to.runner)}"] [data-agent="${CSS.escape(rowOf(to))}"]`
		const state = (status) => (['working', 'blocked'].includes(status) ? status : '')
		/** @type {{ from: string, to: string, fromSide: string, toSide: string, fromAt: number | string, toAt: number, state: string }[]} */
		const edges = [
			{
				from: '.client',
				to: '.server',
				fromSide: 'right',
				toSide: 'left',
				fromAt: 18,
				toAt: 18,
				state: connected() ? '' : 'off',
			},
		]
		const reached = new Set([
			...asking.map((to) => to.runner),
			...agents().map((agent) => agent.to.runner),
		])
		for (const runner of runners)
			if (!reached.has(runner.name))
				edges.push({
					...down,
					from: '.server',
					to: `[data-runner="${CSS.escape(runner.name)}"]`,
					toAt: 40,
					state: connected() && runner.online ? '' : 'off',
				})
		for (const agent of agents()) {
			if (agent.thread === current() && asking.some((to) => rowOf(to) === rowOf(agent.to))) continue
			edges.push({
				...down,
				from: `[data-thread="${agent.thread}"]`,
				to: row(agent.to),
				toAt: -20,
				state: state(agent.status),
			})
		}
		for (const to of asking)
			edges.push({
				...down,
				from: '.thread.current .pick',
				to: row(to),
				toAt: -20,
				state:
					state(
						agents().find((agent) => agent.thread === current() && rowOf(agent.to) === rowOf(to))
							?.status,
					) || 'route',
			})
		return edges
	})
	return html`
		<div class="system">
			<${QuoteButton} />
			<${Wires} connections=${() => connections()} />
			<div class="node client"><b>Client</b></div>
			<div class=${() => ['node', 'server', { off: !connected() }]}>
				<b><${Dot} state=${() => (connected() ? 'on' : '')} />Server</b>
				<small><code>${() => url}</code></small>
				<div class="body">
					<${ThreadList} />
					<${ListEdge} />
					<div class="threads">
						<${Show} when=${() => inboxOpen() && server().modules.includes('inbox')}>
							<${Inbox} />
						<//>
						<${Show} when=${searching}>
							<${Search} />
						<//>
						<${Show} when=${showingUsage}>
							<${Usage} />
						<//>
						<${For}
							each=${() =>
								(inboxOpen() && server().modules.includes('inbox')) || searching() || showingUsage()
									? []
									: columns()}
							>${(id) => html`
								<${Thread} id=${() => id} />
								<${Show} when=${() => sideOf(id)}>
									<${SideEdge} />
									<${Show} when=${() => sideOf(id)?.key} keyed>
										${(key) => html`<${SIDE_PAGES[key] ?? DetailsPage} id=${id} />`}
									<//>
									<${SideEdge} after />
								<//>
							`}<//
						>
					</div>
				</div>
			</div>
			<div class="runners">
				<${For} each=${() => runners}
					>${(runner) => html` <${Runner} runner=${() => runner} agents=${() => agents()} /> `}<//
				>
			</div>
		</div>
	`
}

function ListEdge() {
	const list = (el) => el.parentElement.querySelector('.thread-list')
	/** As narrow as the list's foot lets it: Inbox, every runner's count and the gear on one line */
	const least = (edge) => {
		const foot = list(edge).querySelector('.list-foot')
		if (!foot) return 160
		const room = foot.getBoundingClientRect().width
		foot.style.width = 'max-content'
		const needs = foot.getBoundingClientRect().width
		foot.style.width = ''
		return Math.ceil(list(edge).getBoundingClientRect().width - room + needs)
	}
	const fit = (edge, px) => Math.max(Math.round(Math.min(px, 640, innerWidth / 2)), least(edge))
	let edge
	/** A width saved narrower than the foot needs, or one a new runner or Inbox outgrew, goes up to it */
	const raise = () => {
		// Hidden on a phone, where the list is a drawer of its own width
		if (!edge?.offsetParent) return
		const needs = least(edge)
		if (list(edge).getBoundingClientRect().width < needs) listWidth.set(needs)
	}
	onSettled(() => {
		const foot = list(edge).querySelector('.list-foot')
		const watcher = new MutationObserver(raise)
		if (foot) watcher.observe(foot, { childList: true, subtree: true, characterData: true })
		raise()
		document.fonts.ready.then(raise)
		addEventListener('resize', raise)
		return () => {
			watcher.disconnect()
			removeEventListener('resize', raise)
		}
	})
	return Edge({
		ref: (el) => (edge = el),
		label: 'Thread list width',
		width: (edge) => list(edge).offsetWidth,
		drag: (edge) => {
			const left = list(edge).getBoundingClientRect().left
			return (pointer) => listWidth.set(fit(edge, pointer.clientX - left))
		},
		set: (edge, px) => listWidth.set(px && fit(edge, px)),
		grow: 1,
		edge: 'list-edge',
	})
}

/** The side column's edges drag the same way, either side of it: the recap, details and canvas share its width. */
function SideEdge(props) {
	const fit = (px) => Math.round(Math.min(Math.max(px, 288), innerWidth * 0.7))
	const page = (el) => (props.after ? el.previousElementSibling : el.nextElementSibling)
	return Edge({
		label: 'Side column width',
		width: (edge) => page(edge).offsetWidth,
		drag: (edge) => {
			const rect = page(edge).getBoundingClientRect()
			const wanted = (pointer) =>
				props.after ? pointer.clientX - rect.left : rect.right - pointer.clientX
			// The threads beside it keep their own least width, so the page stops where it would squeeze one.
			return (pointer) => {
				sideWidth.set(fit(wanted(pointer)))
				sideWidth.set(Math.min(fit(wanted(pointer)), page(edge).offsetWidth))
			}
		},
		set: (edge, px) => sideWidth.set(px && fit(px)),
		get grow() {
			return props.after ? 1 : -1
		},
		edge: 'side-edge',
	})
}

function Edge(props) {
	return html`
		<div
			ref=${(el) => props.ref?.(el)}
			class=${() => props.edge}
			role="separator"
			aria-orientation="vertical"
			aria-label=${() => props.label}
			tabindex="0"
			title="Drag to resize; double-click to reset"
			onPointerDown=${(event) => {
				const edge = event.currentTarget
				edge.setPointerCapture(event.pointerId)
				const move = props.drag(edge)
				const up = () => {
					edge.removeEventListener('pointermove', move)
					edge.removeEventListener('pointerup', up)
					document.body.classList.remove('resizing')
				}
				edge.addEventListener('pointermove', move)
				edge.addEventListener('pointerup', up)
				document.body.classList.add('resizing')
				event.preventDefault()
			}}
			onDblClick=${(event) => props.set(event.currentTarget, null)}
			onKeyDown=${(event) => {
				const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key]
				if (!step) return
				event.preventDefault()
				props.set(event.currentTarget, props.width(event.currentTarget) + props.grow * step)
			}}
		></div>
	`
}

/** A dragged width stays here, on this device; a double-click puts it back. */
function width(key, property) {
	const apply = (px) => {
		if (px) document.documentElement.style.setProperty(property, `${px}px`)
		else document.documentElement.style.removeProperty(property)
	}
	try {
		apply(Number(localStorage.getItem(key)))
	} catch {}
	return {
		set(px) {
			apply(px)
			try {
				if (px) localStorage.setItem(key, String(px))
				else localStorage.removeItem(key)
			} catch {}
		},
	}
}
const listWidth = width('ade.list-width', '--list-width')
const sideWidth = width('ade.side-width', '--side-width')
