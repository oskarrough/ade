/**
 * Usage: the tokens agents spent and their cost at list price. The house's as a page in the threads' place, opened from
 * settings: its totals, what the tokens were, each day, then threads, bots and models. A thread's in its details.
 */
import html from '@solidjs/html'
import {
	createDeferred,
	createMemo,
	createSignal,
	Errored,
	For,
	isPending,
	latest,
	Loading,
	Show,
} from 'solid-js'
import { api, connected, current, openThread, threadOf, titleOf } from './server.js'
import { shortLabel } from './agent.js'
import { Icon } from './icons.js'

const DAY = 86_400_000
/** How far back a view counts, from local midnight `days - 1` days ago */
const RANGES = [
	{ key: 'today', label: 'Today', days: 1 },
	{ key: 'week', label: 'Last 7 days', days: 7 },
	{ key: 'fortnight', label: 'Last 14 days', days: 14 },
	{ key: 'month', label: 'Last 30 days', days: 30 },
	{ key: 'quarter', label: 'Last 90 days', days: 90 },
	{ key: 'all', label: 'All time' },
]
const midnight = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime()
const sinceOf = (key) => {
	const { days } = RANGES.find((range) => range.key === key) ?? {}
	return days ? midnight() - (days - 1) * DAY : 0
}
/** What this clock adds to UTC, so the server's days start at our midnight */
const zone = () => -new Date().getTimezoneOffset() * 60_000

const number = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const dollars = (value) => `$${value.toFixed(2)}`
const tokensOf = (count) => count.input + count.output + count.cacheRead + count.cacheWrite
const cachedOf = (count) => {
	const prompt = count.input + count.cacheRead + count.cacheWrite
	return prompt ? Math.round((count.cacheRead / prompt) * 100) : 0
}
const percent = (part, whole) => {
	const share = whole ? (part / whole) * 100 : 0
	return share >= 10 || share === 0 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`
}
/** Tokens, the honest number, and what share of the prompt came from cache */
const tokens = (count) => `${number.format(tokensOf(count))} tokens, ${cachedOf(count)}% from cache`
/** The list price, and the part of it that's a real bill */
const cost = (count) =>
	`${dollars(count.cost)}${count.billed >= 0.005 ? `, ${dollars(count.billed)} billed` : ''}`
const calls = (count) => `${count.calls.toLocaleString()} ${count.calls === 1 ? 'call' : 'calls'}`

const LIST_PRICE =
	'List price is what the tokens would cost on an API key; a subscription login bills none of it.'

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

const KINDS = [
	{ key: 'cacheRead', label: 'Cache read' },
	{ key: 'cacheWrite', label: 'Cache write' },
	{ key: 'input', label: 'Input' },
	{ key: 'output', label: 'Output' },
]
/** What the tokens were, as one bar cut in four, each part named with its count and share */
const Mix = (props) => {
	const whole = () => tokensOf(props.count)
	return html`
		<div class="usage-mix">
			<div class="bar" role="img" aria-label=${() => `${tokens(props.count)}`}>
				<${For} each=${KINDS}
					>${(kind) =>
						html`<span
							class=${kind.key}
							style=${() => ({ 'flex-grow': props.count[kind.key] })}
						></span>`}<//
				>
			</div>
			<div class="legend">
				<${For} each=${KINDS}
					>${(kind) =>
						html`<span class=${kind.key}
							>${kind.label} ${() => number.format(props.count[kind.key])}
							<i>${() => percent(props.count[kind.key], whole())}</i></span
						>`}<//
				>
			</div>
		</div>
	`
}

/** A bar for each day of the range, its height the day's cost or tokens, days without calls empty */
const Days = (props) => {
	const bars = createMemo(() => {
		const known = new Map(props.days.map((day) => [day.day, day]))
		const first = props.since || props.days[0]?.day || midnight()
		const out = []
		for (
			let day = first;
			day <= midnight();
			day = new Date(day).setDate(new Date(day).getDate() + 1)
		)
			out.push({ day, count: known.get(day) })
		return out
	})
	const valueOf = (count) => (count ? (props.measure === 'cost' ? count.cost : tokensOf(count)) : 0)
	const top = () => Math.max(...bars().map((bar) => valueOf(bar.count)), 0) || 1
	const label = (day) =>
		new Date(day).toLocaleDateString(undefined, {
			weekday: 'short',
			day: 'numeric',
			month: 'short',
		})
	return html`
		<div class="usage-days">
			<${For} each=${bars}
				>${(bar) => html`
					<div
						title=${() =>
							`${label(bar.day)}: ${bar.count ? `${cost(bar.count)} · ${tokens(bar.count)} · ${calls(bar.count)}` : 'no calls'}`}
					>
						<span style=${() => ({ height: `${(valueOf(bar.count) / top()) * 100}%` })}></span>
						<small>${new Date(bar.day).getDate()}</small>
					</div>
				`}<//
			>
		</div>
	`
}

/** One row per model, with whose it was where several agents share the list */
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

/** The house's usage in the threads' place: totals, the token mix, each day, then threads, bots and models */
export function Usage() {
	const [range, setRange] = createSignal('fortnight')
	const [measure, setMeasure] = createSignal('cost')
	const usage = createMemo((previous) => {
		const since = sinceOf(range())
		return connected()
			? api(`/api/usage?since=${since}&zone=${zone()}`).then((found) => ({ ...found, since }))
			: previous
	})
	return html`
		<article class="thread current inbox usage" aria-label="Usage">
			<header>
				<h2 class="title">
					<button type="button" class="ghost thread-name" title="Tokens and cost across the house">
						<span>Usage</span>
					</button>
				</h2>
				<button
					type="button"
					class="close"
					title="Back to the thread"
					aria-label="Close"
					onClick=${() => openThread(current())}
				>
					<${Icon} name="close" />
				</button>
			</header>
			<ul>
				<li class="usage-range"><${Range} range=${() => latest(range)} onPick=${setRange} /></li>
				<${Errored}
					fallback=${(error) => html`<li class="mute" role="alert">${() => error().message}</li>`}
				>
					<${Loading} fallback=${html`<li class="mute">Counting…</li>`}>
						<${Show} when=${() => isPending(usage) && usage()}>
							<li class="mute" role="status">Updating usage…</li>
						<//>
						<${Show} when=${usage} keyed fallback=${html`<li class="mute">Counting…</li>`}
							>${(found) => html`
								<${Show}
									when=${() => found.total.calls}
									fallback=${html`<li class="mute">No model calls in this time.</li>`}
								>
									<li class="usage-total" title=${LIST_PRICE}>
										<b>${() => `${cost(found.total)} at list price`}</b>
										<small
											>${() =>
												`${number.format(tokensOf(found.total))} tokens · ${calls(found.total)} · ${found.threadCount} ${found.threadCount === 1 ? 'thread' : 'threads'}`}</small
										>
									</li>
									<li><${Mix} count=${found.total} /></li>
									<li>
										<nav class="tabs" aria-label="Days by">
											<${For} each=${['cost', 'tokens']}
												>${(key) =>
													html`<button
														type="button"
														class="ghost small"
														aria-pressed=${() => String(measure() === key)}
														onClick=${(_event) => setMeasure(key)}
													>
														${key === 'cost' ? 'Cost' : 'Tokens'}
													</button>`}<//
											>
										</nav>
										<${Days} days=${found.days} since=${found.since} measure=${measure} />
									</li>
									<li>
										<h3>Threads</h3>
										<ul class="rows usage">
											<${For} each=${found.threads}
												>${(row) => html`
													<li
														role="button"
														tabindex="0"
														onClick=${(_event) => openThread(row.thread)}
														onKeyDown=${(event) =>
															event.key === 'Enter' &&
															event.target === event.currentTarget &&
															openThread(row.thread)}
													>
														<div>
															<b
																>${() => (threadOf(row.thread) ? titleOf(row.thread) : row.title)}</b
															>
															<small
																>${() =>
																	`${percent(row.cost, found.total.cost)} · ${cost(row)} · ${calls(row)}${row.archived ? ' · archived' : ''}`}</small
															>
															<small>${() => tokens(row)}</small>
														</div>
													</li>
												`}<//
											>
										</ul>
									</li>
									<li>
										<h3>Bots</h3>
										<ul class="rows usage">
											<${For} each=${found.bots}
												>${(row) => html`
													<li>
														<div>
															<b
																>${() => (row.bot === 'agent' ? "Threads' own agents" : row.bot)}</b
															>
															<small
																>${() =>
																	`${percent(row.cost, found.total.cost)} · ${cost(row)} · ${calls(row)}`}</small
															>
															<small>${() => tokens(row)}</small>
														</div>
													</li>
												`}<//
											>
										</ul>
									</li>
									<li>
										<h3>Models</h3>
										<ul class="rows usage">
											<${ModelRows} models=${found.models} />
										</ul>
									</li>
								<//>
							`}<//
						>
					<//>
				<//>
			</ul>
		</article>
	`
}

/** A thread's usage in its details: its total, the token mix and a row per agent and model, fetched again when its work starts or ends */
export function ThreadUsage(props) {
	const [range, setRange] = createSignal('all')
	// Counting tokens should not hold the thread’s work status back.
	const usage = createDeferred((previous) => {
		const thread = props.thread
		const since = sinceOf(range())
		void threadOf(thread)?.busy
		return connected() ? api(`/api/threads/${thread}/usage?since=${since}`) : previous
	})
	return html`
		<h2>Usage</h2>
		<${Range} range=${range} onPick=${setRange} />
		<${Errored}
			fallback=${(error) => html`<p class="mute" role="alert">${() => error().message}</p>`}
		>
			<${Loading} fallback=${html`<p class="mute">Counting…</p>`}>
				<${Show} when=${() => isPending(usage) && usage()}>
					<p class="mute" role="status">Updating usage…</p>
				<//>
				<${Show} when=${usage} keyed fallback=${html`<p class="mute">Counting…</p>`}
					>${(found) => html`
						<${Show}
							when=${() => found.total.calls}
							fallback=${html`<p class="mute">No model calls in this time.</p>`}
						>
							<ul class="rows usage">
								<li title=${LIST_PRICE}>
									<div>
										<b>${() => `${cost(found.total)} at list price`}</b>
										<small
											>${() =>
												found.models.length === 1
													? `${calls(found.total)} · ${found.models[0].model}`
													: calls(found.total)}</small
										>
										<${Mix} count=${found.total} />
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
			<//>
		<//>
	`
}
