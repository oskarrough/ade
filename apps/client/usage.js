/** Usage: the tokens agents spent and their cost at list price, for the whole house from the list's foot and for one thread in its details. */
import html from '@solidjs/html'
import { createEffect, createSignal, createUniqueId, For, Show } from 'solid-js'
import { api, connected, openThread, threadOf, titleOf } from './server.js'
import { placePopover } from './popover.js'
import { Panes } from './panes.js'
import { shortLabel } from './agent.js'
import { report } from './notice.js'

const DAY = 86_400_000
/** How far back a view counts, from local midnight `days - 1` days ago */
const RANGES = [
	{ key: 'today', label: 'Today', days: 1 },
	{ key: 'week', label: 'Last 7 days', days: 7 },
	{ key: 'month', label: 'Last 30 days', days: 30 },
	{ key: 'all', label: 'All time' },
]
const sinceOf = (key) => {
	const { days } = RANGES.find((range) => range.key === key) ?? {}
	if (!days) return 0
	const midnight = new Date()
	midnight.setHours(0, 0, 0, 0)
	return midnight.getTime() - (days - 1) * DAY
}

const number = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const dollars = (value) => `$${value.toFixed(2)}`
const tokensOf = (count) => count.input + count.output + count.cacheRead + count.cacheWrite
/** Tokens, the honest number, and what share of the prompt came from cache */
const tokens = (count) => {
	const prompt = count.input + count.cacheRead + count.cacheWrite
	const cached = prompt ? Math.round((count.cacheRead / prompt) * 100) : 0
	return `${number.format(tokensOf(count))} tokens, ${cached}% from cache`
}
/** The list price, and the part of it that's a real bill */
const cost = (count) =>
	`${dollars(count.cost)}${count.billed >= 0.005 ? `, ${dollars(count.billed)} billed` : ''}`
const calls = (count) => `${count.calls.toLocaleString()} ${count.calls === 1 ? 'call' : 'calls'}`

/** The range picker both views share; each keeps its own pick */
const Range = (props) => html`
	<select
		class="small"
		aria-label="Usage over"
		onChange=${(event) => props.onPick(event.currentTarget.value)}
	>
		<${For} each=${RANGES}
			>${(range) =>
				html`<option value=${range.key} selected=${() => props.range === range.key}>
					${range.label}
				</option>`}<//
		>
	</select>
`

/** One row per model, with whose it was where a thread has several agents */
const ModelRows = (props) => html`
	<${For} each=${() => props.models}
		>${(row) => html`
			<li title=${() => `${row.provider}/${row.model}`}>
				<div>
					<b>${() => row.model}</b>
					<small
						>${() =>
							[props.agents ? shortLabel(row.agent) : row.provider, calls(row)].join(' · ')}</small
					>
					<small>${() => `${tokens(row)} · ${cost(row)}`}</small>
				</div>
			</li>
		`}<//
	>
`

const TOTAL =
	'List price is what the tokens would cost on an API key; a subscription login bills none of it.'

/** The house's usage in a popover from the list's foot: its total, each model, then the threads that cost most */
export function UsageList() {
	let button, panel
	const id = createUniqueId()
	const [range, setRange] = createSignal('week')
	const [usage, setUsage] = createSignal()
	const load = () => api(`/api/usage?since=${sinceOf(range())}`).then(setUsage, report)
	createEffect(
		() => [range(), connected()],
		([, online]) => {
			if (online && panel?.matches(':popover-open')) load()
		},
	)
	const go = (thread) => {
		panel.hidePopover()
		openThread(thread)
	}
	return html`
		<button
			class="ghost small foot-toggle usage-toggle"
			type="button"
			aria-label="Usage"
			title="Tokens and cost across the house"
			ref=${(el) => (button = el)}
			popovertarget=${id}
		>
			<span>Usage</span>
		</button>
		<div
			class="popover usage-list"
			id=${id}
			popover
			ref=${(el) => (panel = el)}
			onToggle=${(event) => {
				if (event.newState !== 'open') return
				placePopover(panel, button)
				load()
			}}
		>
			<${Panes} title="Usage" open=${() => false} onClose=${(_event) => panel.hidePopover()}>
				<${Range} range=${range} onPick=${setRange} />
				<${Show} when=${usage} keyed fallback=${html`<p class="mute">Counting…</p>`}
					>${(found) => html`
						<${Show}
							when=${() => found.total.calls}
							fallback=${html`<p class="mute">No model calls in this time.</p>`}
						>
							<ul class="rows">
								<li title=${TOTAL}>
									<div>
										<b>${() => `${cost(found.total)} at list price`}</b>
										<small>${() => calls(found.total)}</small>
										<small>${() => tokens(found.total)}</small>
									</div>
								</li>
								<${ModelRows} models=${found.models} />
							</ul>
							<h2>Threads</h2>
							<ul class="rows">
								<${For} each=${found.threads}
									>${(row) => html`
										<li
											role="button"
											tabindex="0"
											onClick=${(_e) => go(row.thread)}
											onKeyDown=${(event) =>
												event.key === 'Enter' &&
												event.target === event.currentTarget &&
												go(row.thread)}
										>
											<div>
												<b>${() => (threadOf(row.thread) ? titleOf(row.thread) : row.title)}</b>
												<small>${() => `${calls(row)}${row.archived ? ' · archived' : ''}`}</small>
												<small>${() => `${tokens(row)} · ${cost(row)}`}</small>
											</div>
										</li>
									`}<//
								>
							</ul>
						<//>
					`}<//
				>
			<//>
		</div>
	`
}

/** A thread's usage in its details: its total and a row per agent and model, fetched again when its work starts or ends */
export function ThreadUsage(props) {
	const [range, setRange] = createSignal('all')
	const [usage, setUsage] = createSignal()
	createEffect(
		() => [props.thread, range(), threadOf(props.thread)?.busy, connected()],
		([thread, picked, , online]) => {
			if (online)
				api(`/api/threads/${thread}/usage?since=${sinceOf(picked)}`).then(setUsage, report)
		},
	)
	return html`
		<h2>Usage</h2>
		<${Range} range=${range} onPick=${setRange} />
		<${Show} when=${usage} keyed
			>${(found) => html`
				<${Show}
					when=${() => found.total.calls}
					fallback=${html`<p class="mute">No model calls in this time.</p>`}
				>
					<ul class="rows usage">
						<li title=${TOTAL}>
							<div>
								<b>${() => `${cost(found.total)} at list price`}</b>
								<small
									>${() =>
										found.models.length === 1
											? `${calls(found.total)} · ${found.models[0].model}`
											: calls(found.total)}</small
								>
								<small>${() => tokens(found.total)}</small>
							</div>
						</li>
						<${Show} when=${() => found.models.length > 1}>
							<${ModelRows}
								models=${found.models}
								agents=${new Set(found.models.map((row) => row.agent)).size > 1}
							/>
						<//>
					</ul>
				<//>
			`}<//
		>
	`
}
