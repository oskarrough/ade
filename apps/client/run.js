/** An agent's turns, read from its own conversation: each one line in the thread, opened into every step it took */
import html from '@solidjs/html'
import {
	createEffect,
	createMemo,
	createSignal,
	createStore,
	For,
	onSettled,
	reconcile,
	Show,
} from 'solid-js'
import { entries, titleOf } from './server.js'
import { Cross, MessageMarkdown, Name } from './thread.js'
import { doing, messageText, setDoing, touched } from './agent.js'
import { Icon } from './icons.js'

/**
 * A turn's line. While its agent works, the step it's in now, and below it the last few steps and the words coming in;
 * when the turn ends, its summary. Open, every step in order.
 */
export function Turn(props) {
	const live = () => props.live && doing[props.thread]?.[props.agent.conversation]
	const [open, setOpen] = createSignal(false)
	createEffect(
		() => props.live,
		(on) => (on ? tick() : undefined),
	)
	/** Its steps, the handed one as what it adds to the thread: nothing for the one message above, else a count that opens onto them */
	const steps = createMemo(
		() => {
			const all = props.turn?.steps ?? []
			if (all[0]?.label !== 'handed') return all
			const step = handedStep(all[0], props.thread, entries[props.thread] ?? [])
			return step ? [step, ...all.slice(1)] : all.slice(1)
		},
		// The 'handed' branch rebuilds its first step fresh every run, from any unrelated message landing in the
		// thread, even when what it says (in, text) comes out the same; without this, every subscriber (now(),
		// calls(), summed()) redoes its own work on every one of those too.
		{
			equals: (a, b) =>
				a.length === b.length &&
				a.every((step, i) => step === b[i] || (step?.in === b[i]?.in && step?.text === b[i]?.text)),
		},
	)
	const now = () => {
		const running = steps().findLast((step) => step.name && !step.result)
		if (running)
			return running.name === 'post'
				? `asking ${askedThread(running) ? titleOf(askedThread(running)) : (running.args.title ?? 'a new thread')}`
				: `${running.name}(${(touched(running.args) ?? JSON.stringify(running.args)).split('\n')[0]})`
		if (props.agent.status === 'blocked')
			return `waiting for ${props.agent.to?.runner ?? 'its runner'} to come online`
		return messageText(live()?.message) ? 'writing' : 'thinking'
	}
	const calls = () => steps().filter((step) => step.name)
	/** A closed turn's summary, worked out when its steps change; an equal string updates nothing */
	const summed = createMemo(() => (props.live ? '' : summary({ ...props.turn, steps: steps() })))
	const line = () => {
		if (!props.live) return summed()
		const start = props.turn?.start
		return [
			now(),
			calls().length && plural(calls().length, 'step'),
			start && clock() - start >= 1000 && seconds(clock() - start),
		]
			.filter(Boolean)
			.join(', ')
	}
	const said = () => messageText(live()?.message)
	/** A closed turn of one step opens straight to what that step holds, with no row naming it again */
	const single = () => (!props.live && steps().length === 1 ? steps()[0] : null)
	return html`
		<li class=${() => ({ turn: true, live: !!props.live, same: !props.name })}>
			<${Show} when=${() => props.name}><${Name} author=${() => props.name} /><//>
			<details onToggle=${(event) => setOpen(event.currentTarget.open)}>
				<summary>
					<small><span class="now">${line}</span></small>
				</summary>
				<${Show} when=${() => open() && single()}>
					<${Whole} step=${single} />
				<//>
				<${Show} when=${() => open() && !single()}>
					<ol
						class="steps"
						style=${() => `--label: ${Math.max(...steps().map((step) => (step.name ?? step.label ?? '').length))}ch`}
					>
						<${For} each=${steps} keyed=${(step) => step.key}
							>${(step) => html`
								<${Show}
									when=${() => step().name || step().label}
									fallback=${() => html`<li class="said">${() => step().said}</li>`}
								>
									<${Call} step=${() => step()} />
								<//>
							`}<//
						>
						<${Show} when=${said}
							><li class="said"><${MessageMarkdown} text=${said} live=${true} /></li
						><//>
					</ol>
				<//>
			</details>
		</li>
	`
}

/**
 * A post, from the thread that sent it: the message as a sent step, pulsing while the asked thread works, then the
 * answer as a received one when it comes.
 */
export function Exchange(props) {
	const row = () => props.row
	const took = () => {
		const start = row().ask.result?.time
		const end = row().back
		return start && end && end - start >= 1000 ? seconds(end - start) : ''
	}
	return html`
		<li class=${() => ({ exchange: true, handed: litIn(props.thread, row().answer?.id) })}>
			<ol class="steps">
				<${Cross} row=${row} data=${() => ({ ...row().ask.args, author: row().agent?.name })} />
				<${Show} when=${() => row().answer}>
					<${Cross}
						row=${row}
						sent=${false}
						data=${() => row().answer.data}
						title=${() => (took() ? `answered in ${took()}` : undefined)}
					/>
				<//>
			</ol>
		</li>
	`
}

function Call(props) {
	const result = () => props.step.result
	const [open, setOpen] = createSignal(false)
	const toggle = (on) => {
		setOpen(on)
		if (props.step.held) light(on ? props.step : null, props.step)
	}
	// Closed with its turn, it lets go of what it lit
	onSettled(() => () => props.step.held && light(null, props.step))
	return html`
		<li
			class=${() =>
				props.step.name
					? { call: true, failed: result()?.error, running: !result() }
					: `call told ${props.step.label}`}
		>
			<details onToggle=${(event) => toggle(event.currentTarget.open)}>
				<summary>
					<span class="tool">${() => props.step.name ?? props.step.label}</span>
					<span class="in"
						>${() => (props.step.name ? JSON.stringify(props.step.args) : (props.step.in ?? props.step.text ?? ''))}</span
					>
				</summary>
				<${Show} when=${open}><${Whole} step=${() => props.step} /><//>
			</details>
		</li>
	`
}

/** What an opened step holds, one fold in: a call's input and result as code, a thought or note as plain grey text */
const Whole = (props) => html`
	<div class="whole">
		<${Show}
			when=${() => props.step.name}
			fallback=${html`<p>${() => props.step.text ?? props.step.said}</p>`}
		>
			<pre>${() => JSON.stringify(props.step.args, null, 2)}</pre>
			<${Show} when=${() => props.step.result?.text}><pre>${() => props.step.result.text}</pre><//>
		<//>
	</div>
`

/** The messages an opened handed step lights where they are in the thread */
const [lit, setLit] = createSignal(null)
/** Lights a step's messages, or with `null` puts out what `step` lit */
const light = (on, step) =>
	setLit((now) =>
		on
			? { thread: on.thread, ids: new Set(on.held), step: on.key }
			: now?.step === step.key
				? null
				: now,
	)
export const litIn = (thread, id) => lit()?.thread === thread && !!lit()?.ids.has(id)

/**
 * A turn's handed step as the thread sees it: none when it was handed just the one message above it, else a count of
 * the messages and a reply from each thread that answered, and only the words the thread doesn't show.
 */
function handedStep(step, thread, messages) {
	const byId = new Map(messages.map((entry) => [entry.id, entry]))
	const held = step.held.map((id) => byId.get(id) ?? { id, data: {} })
	const replies = held.filter((entry) => entry.data.from && entry.data.re)
	const said = held.length - replies.length
	/** What a delivery carried that the thread doesn't show: a note that the agent moved, and memory's lines for what didn't fit */
	const unseen = [
		[/^\[You now run as [^\n]*\]/, 'a note'],
		[/<chat>\n[\s\S]*?\n<\/chat>/, 'memory lines'],
	].flatMap(([pattern, word]) => {
		const found = (step.text ?? '').match(pattern)
		return found ? [{ word, text: found[0] }] : []
	})
	if (said === 1 && !replies.length && !unseen.length) return null
	return {
		...step,
		thread,
		in: [
			said && plural(said, 'message'),
			...replies.map((entry) => `a reply from ${titleOf(entry.data.from)}`),
			...unseen.map((part) => part.word),
		]
			.filter(Boolean)
			.join(' + '),
		text: unseen.map((part) => part.text).join('\n\n'),
	}
}

/** What a turn did, in a few words; its asks have their own lines */
function summary(turn) {
	const tools = turn.steps.filter((step) => step.name)
	const edited = [
		...new Set(
			tools
				.filter(
					(step) => ['edit', 'write'].includes(step.name) && step.result && !step.result.error,
				)
				.map((step) => step.args.path?.split('/').pop()),
		),
	].filter(Boolean)
	const commands = tools.filter((step) => step.name === 'bash').length
	const answeredThreads = tools.filter((step) => step.name === 'post' && answered(step))
	const parts = [
		edited.length && `edited ${edited.join(', ')}`,
		commands && plural(commands, 'command'),
		answeredThreads.length &&
			`answered ${answeredThreads.map((step) => titleOf(askedThread(step))).join(', ')}`,
		tools.length && plural(tools.length, 'step'),
		turn.end - turn.start >= 1000 && seconds(turn.end - turn.start),
	]
	// A turn with no call only thought, before its answer or instead of one
	return parts.filter(Boolean).join(', ') || 'thought'
}

/** A post's ask: the thread it went to, or for an answer, the thread it answered */
export const askedThread = (step) => step.result?.details?.thread ?? step.args.thread
const answered = (step) => /^Answered /.test(step.result?.text ?? '')

const seconds = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000))
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}
export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One clock for every live turn, ticking only while one is on screen */
const [clock, setClock] = createSignal(Date.now())
let ticking = 0,
	timer
const tick = () => {
	if (!ticking++) timer = setInterval(() => setClock(Date.now()), 1000)
	return () => --ticking || clearInterval(timer)
}

/**
 * Each agent conversation on screen, its entries as Pi keeps them.
 * Entries never change once written, so the store is shallow: a read tracks the conversation, not each entry's fields.
 */
const [conversations, setConversations] = createStore({}, { shallow: true })

export { conversations }
/** Each agent's newest compaction cut, as the socket sends it with the first batch and after each compaction: `null` for none */
const [compactions, setCompactions] = createStore({}, { shallow: true })

/**
 * Takes an `agents/<thread>` frame apart: each agent's live work and cut as they come, and its conversation again only
 * when its entries changed, so a turn streaming its words doesn't rebuild the turns
 */
export function heardAgents(rows, frame, reset) {
	const thread = Number(/^agents\/(\d+)/.exec(frame.view)?.[1])
	const touched = new Set((frame.del ?? []).map((key) => Number(key.split('/')[0])))
	for (const { row } of frame.put ?? []) {
		if ('live' in row)
			setDoing((work) => {
				work[thread] ??= {}
				work[thread][row.agent] ??= {}
				reconcile(row.live, 'callId')(work[thread][row.agent])
			})
		else if ('cut' in row)
			setCompactions((all) => {
				all[row.agent] = row.cut
			})
		if (reset || 'id' in row) touched.add(row.agent)
	}
	const lists = new Map([...touched].map((agent) => [agent, []]))
	for (const row of rows.values()) if ('id' in row) lists.get(row.agent)?.push(row)
	setConversations((all) => {
		for (const [agent, list] of lists) all[agent] = list.sort((left, right) => left.id - right.id)
	})
}

/**
 * Where an agent's newest compaction cuts, as the thread's message ids, or `null`: the first message of the first delivery the agent still reads whole.
 * Older compactions are history the agent no longer reads, so they don't show. `memory` is whether the summary is the thread's memory lines, or Pi's own.
 */
export function cutOf(conversation) {
	const entry = compactions[conversation]
	if (!entry) return null
	const { first } = entry
	const summary = messageText(entry.model?.[0]) || ''
	// With memory the summary is its lines, `id+n|text`; otherwise it is Pi's own text
	const lines = [...summary.matchAll(/^(\d+)\+(\d+)\|(.*)$/gm)].map((line) => ({
		key: `${conversation}:${line[1]}+${line[2]}`,
		at: Number(line[1]),
		n: Number(line[2]),
		text: line[3],
	}))
	for (let index = lines.length - 1; index >= 0; index--) {
		const line = lines[index]
		if (!line.text.includes('not summarized yet')) continue
		const next = lines[index + 1]
		if (next?.text.includes('not summarized yet') && line.at + line.n === next.at) {
			line.n += next.n
			lines.splice(index + 1, 1)
		}
		line.text = `messages ${line.at}–${line.at + line.n - 1} not summarized yet`
	}
	return {
		key: `${conversation}:cut:${entry.id}`,
		cut: true,
		id: entry.id,
		at: first - 0.5,
		memory: lines.length > 0,
		lines: lines.length
			? lines
			: [{ key: `${conversation}:summary:${entry.id}`, at: 0, n: first, text: summary }],
	}
}

/** A conversation cut into turns: each begins with a delivery and holds the calls, results and words that follow it */
export function turnsOf(conversation) {
	const turns = []
	for (const entry of conversations[conversation] ?? []) {
		const message = entry.model?.[0]
		if (entry.kind === 'ade.delivery') {
			turns.push({
				key: `${conversation}:${entry.id}`,
				delivery: entry.id,
				held: entry.data?.held ?? [],
				after: Math.max(0, ...(entry.data?.held ?? [])),
				start: message?.timestamp,
				end: message?.timestamp,
				steps: [
					{
						key: `${entry.id}:handed`,
						label: 'handed',
						text: typeof message?.content === 'string' ? message.content : messageText(message),
						held: entry.data?.held ?? [],
					},
				],
			})
			continue
		}
		const turn = turns.at(-1)
		if (!turn || !message) continue
		turn.end = message.timestamp ?? turn.end
		if (message.role === 'assistant') {
			for (const block of message.content ?? []) {
				if (block.type === 'toolCall')
					turn.steps.push({
						key: block.id,
						name: block.name,
						args: block.arguments ?? {},
						result: null,
					})
				else if (block.type === 'thinking' && block.thinking?.trim())
					turn.steps.push({
						key: `${entry.id}:thought:${turn.steps.length}`,
						label: 'thought',
						text: block.thinking,
					})
				// The last words are the answer, which the thread shows itself
				else if (block.type === 'text' && block.text.trim() && message.stopReason === 'toolUse')
					turn.steps.push({ key: `${entry.id}:said`, said: block.text })
			}
		}
		if (message.role === 'toolResult') {
			const step = turn.steps.find((step) => step.key === message.toolCallId)
			if (step)
				step.result = {
					at: entry.id,
					time: message.timestamp,
					text: messageText(message),
					error: message.isError,
					details: message.details,
				}
		}
	}
	return turns
}

/**
 * What a conversation says about when thread messages were written, for those from before messages carried their time:
 * `asked`, the message each delivery went out for, by the delivery's time (its newest held; the others it carried along
 * were written earlier), and `said`, each of its entries by its model message's time, which dates the answers copied from them.
 */
export function timesOf(conversation) {
	const asked = new Map()
	const said = new Map()
	for (const entry of conversations[conversation] ?? []) {
		const time = entry.model?.[0]?.timestamp
		if (time === undefined) continue
		said.set(entry.id, time)
		const held = entry.kind === 'ade.delivery' ? (entry.data?.held ?? []) : []
		if (!held.length) continue
		const upTo = Math.max(...held)
		asked.set(upTo, Math.min(asked.get(upTo) ?? Infinity, time))
	}
	return { asked, said }
}

export const newestCut = (cuts) =>
	cuts.reduce((best, cut) => (cut && (!best || cut.id > best.id) ? cut : best), null)

/**
 * The tool calls that change something lasting beyond the run, by name, each with whether a finished call did: these get
 * their own row in the thread instead of folding into their turn. A post that asks another thread; a bot rewriting itself;
 * a batch of canvas actions; a task scheduled or cancelled.
 */
const LASTING = {
	post: (step) => !answered(step) && askedThread(step),
	bot: (step) => step.result.details?.before && changedOf(step).length,
	canvas_act: () => true,
	schedule: () => true,
}
/** A turn's finished calls that changed something lasting */
export const lastingOf = (steps) =>
	steps.filter((step) => step.result && !step.result.error && LASTING[step.name]?.(step))

/** What a bot call changed of its bot, as the words its row names */
const changedOf = (step) =>
	['instructions', 'model'].filter(
		(key) =>
			step.args[key] !== undefined || (key === 'instructions' && step.args.append !== undefined),
	)
/** What a bot call left in place of `key`: an `append` adds its line to the instructions before */
const afterOf = (step, key) =>
	step.args[key] ??
	[step.result.details.before.instructions, step.args.append.trim()].filter(Boolean).join('\n')

/** jsdiff, loaded the first time a change is opened */
let jsdiff
/** Keep the change's own line and the next nonblank one; the rest folds into ⋯. */
function contextOf(lines) {
	for (let index = 1; index < lines.length; index++) if (lines[index].trim()) return index + 1
	return lines.length
}

/**
 * Old against new as one run of words: removed, added and the same, with the same text far from any change folded. A
 * fold keeps its exact text, so opening it reads as the whole.
 */
function wordDiff(diffWords, before, after) {
	const parts = diffWords(before, after)
	return parts.flatMap((part, index) => {
		if (part.added) return [{ kind: 'added', text: part.value }]
		if (part.removed) return [{ kind: 'removed', text: part.value }]
		const lines = part.value.split('\n')
		const first = index === 0
		const last = index === parts.length - 1
		if (first && last) return [{ kind: 'same', text: part.value }]
		const head = first ? 0 : contextOf(lines)
		const tail = last ? 0 : contextOf(lines.toReversed())
		if (lines.length - head - tail < 2) return [{ kind: 'same', text: part.value }]
		return [
			head && { kind: 'same', text: `${lines.slice(0, head).join('\n')}\n` },
			{ kind: 'fold', text: lines.slice(head, lines.length - tail).join('\n') },
			tail && { kind: 'same', text: `\n${lines.slice(lines.length - tail).join('\n')}` },
		].filter(Boolean)
	})
}

/** Unchanged text out of sight, as ⋯ until clicked */
function Fold(props) {
	const [open, setOpen] = createSignal(false)
	return html`
		<${Show}
			when=${open}
			fallback=${() => html`
				<button
					type="button"
					class="ghost fold"
					title="Show the unchanged text"
					onClick=${() => setOpen(true)}
				>
					⋯
				</button>
			`}
			>${() => props.text}<//
		>
	`
}

/**
 * A bot rewriting itself, on its own row, one line: its name, what it updated; opened, each one as a word diff of old
 * against new.
 */
export function Changed(props) {
	const [diffWords, setDiffWords] = createSignal()
	const [failed, setFailed] = createSignal()
	const changes = () =>
		changedOf(props.step).map((key) => ({
			key,
			before: props.step.result.details.before[key] ?? '',
			after: afterOf(props.step, key),
		}))
	const opened = (event) => {
		if (!event.currentTarget.open || diffWords()) return
		;(jsdiff ??= import('diff').catch((error) => {
			jsdiff = undefined
			throw error
		})).then(
			(module) => setDiffWords(() => module.diffWords),
			(error) => setFailed(`Couldn't load the diff: ${error.message}`),
		)
	}
	return html`
		<${PlainStep}
			said=${() => `${props.agent.name} updated their ${changedOf(props.step).join(' and ')}`}
			onToggle=${opened}
		>
			<div class="whole">
				<${Show} when=${failed}>${() => html`<p class="failed">${failed}</p>`}<//>
				<${For} each=${changes} keyed=${(change) => change.key}
					>${(change) => html`
						<div class="change">
							<span class="key">${() => change().key}</span>
							<${Show} when=${diffWords}
								>${() => html`
									<div class="diff">
										<${For} each=${() => wordDiff(diffWords(), change().before, change().after)}
											>${(segment) =>
												segment.kind === 'fold'
													? html`<${Fold} text=${segment.text} />`
													: segment.kind === 'same'
														? segment.text
														: html`<span class=${segment.kind}>${segment.text}</span>`}<//
										>
									</div>
								`}<//
							>
						</div>
					`}<//
				>
			</div>
		<//>
	`
}

/** A lasting change told as one plain sentence on its own row, read as a step, after its `icon` if it has one; opened, what's under it. `entry`, when it is a message of its own, lets search and Jump land on it */
export const PlainStep = (props) => html`
	<li class="elsewhere" data-entry=${() => props.entry}>
		<ol class="steps">
			<li class="call changed plain">
				<details onToggle=${(event) => props.onToggle?.(event)}>
					<summary>
						<${Show} when=${() => props.icon}><${Icon} name=${() => props.icon} /><//
						><span class="in">${() => props.said}</span
						><span class="label">${() => props.label ?? props.said}</span>
					</summary>
					${() => props.children}
				</details>
			</li>
		</ol>
	</li>
`

/** Each post's answer, looked up by the thread it asked instead of scanning every message per post */
export function answersIn(messages) {
	const byThread = new Map()
	for (const entry of messages)
		if (entry.data.from && entry.data.re)
			byThread.set(entry.data.from, [...(byThread.get(entry.data.from) ?? []), entry])
	return (step) =>
		step.name === 'post' &&
		step.result &&
		!step.result.error &&
		!answered(step) &&
		byThread.get(askedThread(step))?.find((entry) => entry.id > step.result.at)
}
