/** Memory belongs to one visible thread. Disposing it discards every outstanding read. */
import html from '@solidjs/html'
import { createMemo, createSignal, For, Loading, Show } from 'solid-js'
import { api, connected, current, entries, feedItem, server, threadOf } from './server.js'
import { cutOf, newestCut, plural } from './run.js'

/**
 * What compaction did to this thread's agent, as a tape of the thread: the part before the newest cut faint, one segment per memory line,
 * the part the agent reads word for word solid.
 */
export function Compaction() {
	return html`
		<${Show} when=${() => current()} keyed>
			${(thread) => html`
				<${Loading} fallback=${html`<p class="mute">Reading the agent…</p>`}>
					<${CompactionOf} thread=${thread} />
				<//>
			`}
		<//>
	`
}

function CompactionOf(props) {
	const cut = createMemo(() =>
		newestCut((threadOf(props.thread)?.agents ?? []).map((agent) => cutOf(agent.conversation))),
	)
	const messages = () => entries[props.thread] ?? []
	const older = () => (cut() ? messages().filter((entry) => entry.id < cut().at).length : 0)
	const newer = () => messages().length - older()
	return html`
		<div class="tape">
			<div class="reel" aria-hidden="true">
				<${Show} when=${() => cut() && older()}>
					<span class="old" style=${() => ({ flex: older() })}>
						<${For} each=${() => (cut().memory ? cut().lines : [])}
							>${(line) => html`<span style=${{ flex: line.n }}></span>`}<//
						>
					</span>
				<//>
				<span class="new" style=${() => ({ flex: Math.max(newer(), 1) })}></span>
			</div>
			<small
				>${() =>
					!cut()
						? 'Not compacted yet'
						: `Older ${plural(older(), 'message')} → ${
								cut().memory ? plural(cut().lines.length, 'memory line') : "Pi's summary"
							}, last ${newer()} word for word`}</small
			>
		</div>
	`
}

export function Memory() {
	const [room, setRoom] = createSignal(30)
	return html`
		<${Show}
			when=${() => connected()}
			fallback=${html`<p class="mute">Disconnected from the server.</p>`}
		>
			<${Show}
				when=${() => server().modules.includes('memory')}
				fallback=${html`
					<p class="mute">
						This server runs without memory. Switch it on in settings beside the runners.
					</p>
				`}
			>
				<${Show} when=${() => current()} keyed>
					${(id) => html`
						<${ThreadMemory}
							thread=${id}
							room=${() => room()}
							onRoom=${(value) => setRoom(value)}
						/>
					`}
				<//>
			<//>
		<//>
	`
}

function ThreadMemory(props) {
	// The keyed owner fixes the thread until this entire view is disposed.
	const read = (query) => api(`/api/threads/${props.thread}/memory${query}`)
	const view = feedItem(() => `memory/${props.thread}?room=${props.room}`)
	const Lines = (props) => html`
		<ul>
			<${For} each=${() => props.nodes} keyed=${key}>
				${(line) => html` <${Line} line=${() => line()} /> `}
			<//>
		</ul>
	`
	function Line(props) {
		const [expanded, setExpanded] = createSignal(false)
		const waiting = () => props.line.text.includes('not summarized yet')
		const opened = createMemo(() =>
			expanded() ? read(`?zoom=${props.line.id},${props.line.n}`) : null,
		)
		return html`
			<li
				data-at=${() => key(props.line)}
				class=${() => [props.line.kind, { pending: waiting() }]}
				title=${() =>
					props.line.n > 1
						? `messages ${props.line.id} to ${props.line.id + props.line.n - 1}`
						: `message ${props.line.id}`}
				onClick=${(event) => {
					event.stopPropagation()
					if (props.line.kind !== 'above') setExpanded((on) => !on)
				}}
			>
				<small>${() => key(props.line)}</small>
				<span>${() => props.line.text}</span>

				<${Show} when=${() => props.line.children}>
					<${Lines} nodes=${() => props.line.children} />
				<//>
				<${Show} when=${() => expanded() && props.line.kind !== 'above'}>
					<${Loading} fallback=${html`<span class="opening">Opening…</span>`}>
						<${Show}
							when=${() => opened()?.message !== undefined}
							fallback=${() => html`
								<${Lines}
									nodes=${() => (opened()?.lines ?? []).map((line) => ({ ...line, kind: 'below' }))}
								/>
							`}
						>
							<div class="whole">${() => opened()?.message}</div>
						<//>
					<//>
				<//>
			</li>
		`
	}

	let root
	return html`
		<div class="memory reads" ref=${(el) => (root = el)}>
			<${Show} when=${view} fallback=${html`<p class="mute">Reading memory…</p>`}
				>${(found) => html`
					<${Show}
						when=${() => found().total}
						fallback=${html`<p class="mute">No messages yet.</p>`}
					>
						<label class="room"
							>Room
							<input
								type="range"
								min="0"
								max="100"
								aria-label="Memory room"
								value=${() => props.room}
								onInput=${(event) => props.onRoom(Number(event.currentTarget.value))}
							/>
							<span
								>${() => {
									const { budget } = found()
									return budget < 1024
										? `${budget} B`
										: `${(budget / 1024).toFixed(budget < 10240 ? 1 : 0)} KB`
								}}</span
							>
						</label>
						<div class="bar">
							<${For} each=${() => found().cut} keyed=${key}>
								${(line) => html`
									<span
										title=${() =>
											`${key(line())}: ` +
											(line().n > 1 ? `${line().n} messages in one line` : 'one message')}
										style=${() => {
											const n = line().n
											const shade = 88 - Math.min(1, Math.log2(n) / 5) * 50
											return `flex-grow:${n};background:hsl(215 60% ${shade}%)`
										}}
										onClick=${() => root.querySelector(`[data-at="${key(line())}"]`)?.click()}
									></span>
								`}
							<//>
						</div>
						<p class="mute">
							${() => {
								const { cut, budget, total } = found(),
									n = cut.length
								return (
									`The agent reads the ${n} highlighted line${n === 1 ? '' : 's'}: ` +
									`${sizeOf(cut).toLocaleString()} of ${budget.toLocaleString()} bytes ` +
									`for ${total} messages. ` +
									(n === total
										? "Room for every message's own line."
										: n <= 2
											? 'As squeezed as it gets: it zooms to read more.'
											: 'Old messages share lines; the latest have one each.')
								)
							}}
						</p>
						<${Lines} nodes=${() => found().tree} />
					<//>
				`}<//
			>
		</div>
	`
}

const sizeOf = (lines) =>
	lines.reduce(
		(sum, line) => sum + new TextEncoder().encode(`${key(line)}|${line.text}`).length + 1,
		0,
	)
const key = (line) => `${line.id}+${line.n}`
