/**
 * The inbox: what needs you, in the threads' place. It opens with one sentence: how much waits on you, how much
 * finished, how much still works. Then what waits, in full: every open question agents asked with `ask_person`, shared
 * by everyone on the server, and runs that failed in threads you wrote in. A question shows its thread, who asked, when,
 * the thread's recap line, and the question as the thread shows it; you answer under it with the thread's own composer,
 * or dismiss it until that thread asks again. Under those, what finished: an answer you haven't read is one line, its
 * thread and how the answer starts, which a tap opens to the whole answer. A thread's title opens it, which clears its
 * failure or answer; dismissing one marks the thread read, for you alone.
 */
import html from '@solidjs/html'
import { createSignal, For, Show, untrack } from 'solid-js'
import {
	colorOf,
	current,
	dismiss,
	feedItem,
	followThread,
	hrefOf,
	inbox,
	openThread,
	server,
	threadOf,
	threadRows,
	titleOf,
	waiting,
} from './server.js'
import { Body, Clamp, links } from './thread.js'
import { authorLabel } from './agent.js'
import { Composer } from './composer.js'
import { topicsOf } from './recap.js'
import { inline } from './markdown.js'
import { Notice, report } from './notice.js'
import { Stamp } from './time.js'
import { Icon } from './icons.js'
import { Dot } from './dot.js'

const finished = () => inbox.filter((item) => item.kind === 'answered')

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const count = (number) => WORDS[number] ?? String(number)

const IDLE_WORKING = [
	'Nothing is waiting on you.',
	'Nothing needs you right now.',
	'Your turn can wait.',
	'The ball is in their court.',
	'Nobody has asked you anything.',
	'You are not the bottleneck.',
	'The work is out of your hands for now.',
	"You've answered everything.",
	"They're on it.",
	"You're caught up.",
	'Your desk is clear.',
	"They'll knock when they need you.",
	'Your silence is holding nothing up.',
	"The errands are running. You needn't.",
	'The familiars are at their work.',
	'Everything is in hand. Not yours, for once.',
	'The spells are cast. Now they simmer.',
	'Work proceeds. It does not require supervision, only patience.',
	'The road goes ever on. Without you, briefly.',
	'A watched thread never finishes.',
	"They'll arrive precisely when they mean to.",
	"Nothing's on fire. I checked.",
	'Second breakfast is not out of the question.',
	'Go look out of a window.',
	'Stand up. Nobody will mind.',
	'Plenty happening, none of it yours.',
	'Think your own thoughts for a while.',
	"Nobody's waiting. Make the most of it.",
	'All is proceeding as foreseen. Roughly.',
	'And now for something completely different: nothing.',
	'Not every hour needs a decision.',
	'Nothing requires your seal.',
	'The machinery hums. You may leave it to hum.',
	'No summons. Carry on.',
	'Clean slate.',
]

const IDLE_QUIET = [
	'Nothing is waiting on you, and nothing is running.',
	"Everything's done. Even the bots.",
	'The house is quiet.',
	'All threads at rest.',
	'Nothing running. Nothing owed.',
	'The candles are out. The work is done.',
	'Even the familiars are asleep.',
	'This inbox is no more. It has ceased to be. It is empty.',
	'Calm waters.',
	'A blank page, if you want one.',
	'Done is a fine place to be.',
	'Nothing in, nothing out.',
	'The fellowship has disbanded for the evening.',
	'Not all who wander are behind on email.',
	"Go outside. It'll keep.",
]

const lastLine = { working: '', quiet: '' }
/** A line for each kind of empty inbox, new on every visit and never the one before */
function idleLines() {
	const pick = (lines, key) => {
		const options = lines.filter((line) => line !== lastLine[key])
		return (lastLine[key] = options[Math.floor(Math.random() * options.length)])
	}
	return { working: pick(IDLE_WORKING, 'working'), quiet: pick(IDLE_QUIET, 'quiet') }
}

/** The page in a sentence, as a colleague would say it */
function brief(idle) {
	const waits = waiting().length
	const done = finished().length
	const working = threadRows().open.filter((row) => row.status === 'working').length
	return [
		waits
			? `${count(waits)} ${waits === 1 ? 'thing is' : 'things are'} waiting on you.`
			: working
				? idle.working
				: idle.quiet,
		done ? `${count(done)} finished.` : '',
		working ? `${count(working)} still working.` : '',
	]
		.filter(Boolean)
		.join(' ')
}

export function Inbox() {
	const idle = idleLines()
	return html`
		<article class="thread current inbox" aria-label="Inbox">
			<header>
				<h2 class="title">
					<button
						type="button"
						class="ghost thread-name"
						title="What needs you: questions and failures, then answers you haven't read"
					>
						<span>${() => (waiting().length ? `Inbox ${waiting().length}` : 'Inbox')}</span>
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
				<li class="room"><${Notice} /></li>
				<li class="brief">${() => brief(idle)}</li>
				<${For} each=${waiting} keyed=${(item) => `${item.kind} ${item.thread}`}>
					${(item) => html`
						<${Show}
							when=${() => item().kind === 'question'}
							fallback=${() => html`<${Failed} item=${item} />`}
						>
							<${Question} item=${item} />
						<//>
					`}
				<//>
				<${Show} when=${() => finished().length}>
					<li class="band"><h3>Finished</h3></li>
				<//>
				<${For} each=${finished} keyed=${(item) => `${item.kind} ${item.thread}`}>
					${(item) => html`<${Finished} item=${item} />`}
				<//>
			</ul>
		</article>
	`
}

/** An item's first line: its thread as the link that opens it, who, when, and the way to put it aside */
function Meta(props) {
	const thread = untrack(() => props.item.thread)
	return html`
		<small class="meta">
			${() => props.children}
			<a
				class="thread-link"
				href=${hrefOf(thread)}
				onClick=${(event) => followThread(event, thread)}
				>${() => titleOf(thread)}</a
			>
			${', '}<span title=${() => props.data.author} style=${() => colorOf(props.data.author)}
				>${() => authorLabel(props.data.author)}</span
			>${() => props.says ?? ''}${', '}<${Stamp}
				time=${() => props.data.createdAt && Date.parse(props.data.createdAt)}
			/>
			<button
				type="button"
				class="ghost small dismiss"
				title=${() => props.dismiss}
				onClick=${() => dismiss(props.item).catch(report)}
			>
				Dismiss
			</button>
		</small>
	`
}

/** One question: its thread, who asked and when, the recap's line, the question, then your answer */
function Question(props) {
	const thread = untrack(() => props.item.thread)
	const data = () => props.item.question.data
	/** The agent that asked, by its conversation, as the thread list has it now */
	const asks = () =>
		props.item.askerTo ??
		threadOf(thread)?.agents.find((agent) => agent.conversation === props.item.asker)?.to
	return html`
		<li class="question" data-thread=${thread}>
			<${Meta}
				item=${() => props.item}
				data=${data}
				dismiss="Hide this question until the thread asks again"
			/>
			<${Show} when=${() => server().modules.includes('recap')}>
				<${RecapLine} thread=${thread} />
			<//>
			<${Body} data=${() => data()} />
			<${Composer} thread=${() => thread} inbox asks=${asks} />
		</li>
	`
}

/** A failed run in a thread you wrote in: its dot, thread, who, when, and what went wrong; opening the thread clears it */
function Failed(props) {
	const thread = untrack(() => props.item.thread)
	const data = () => props.item.message.data
	return html`
		<li class="question" data-thread=${thread}>
			<${Meta} item=${() => props.item} data=${data} says=" failed" dismiss="Mark it read">
				<${Dot} state="error" />
			<//>
			<${Clamp}><${Body} data=${() => data()} /><//>
		</li>
	`
}

/** An answer you haven't read, in a thread you wrote in, on one line: its thread, how the answer starts, and when; a tap on the line opens the whole answer under it */
function Finished(props) {
	const thread = untrack(() => props.item.thread)
	const data = () => props.item.message.data
	const [open, setOpen] = createSignal(false)
	return html`
		<li class="finished" data-thread=${thread}>
			<div class="line">
				<${Dot} state="done" />
				<a
					class="thread-link"
					href=${hrefOf(thread)}
					onClick=${(event) => followThread(event, thread)}
					>${() => titleOf(thread)}</a
				>
				<button
					type="button"
					class="ghost in"
					title="Read the answer here"
					aria-expanded=${() => String(open())}
					onClick=${() => setOpen((was) => !was)}
				>
					${() => (data().body ?? '').replace(/\s+/g, ' ')}
				</button>
				<small><${Stamp} time=${() => data().createdAt && Date.parse(data().createdAt)} /></small>
			</div>
			<${Show} when=${open}>
				<${Body} data=${() => data()} />
				<div class="links">
					<button
						type="button"
						class="ghost small"
						title="Mark it read"
						onClick=${() => dismiss(props.item).catch(report)}
					>
						Dismiss
					</button>
				</div>
			<//>
		</li>
	`
}

/** Where the thread stands, in one line: the recap's newest open topic, else its newest */
function RecapLine(props) {
	const page = feedItem(() => `recap/${props.thread}`)
	const line = () => {
		const topics = topicsOf(page()?.page ?? '')
		return (topics.findLast((topic) => !topic.done) ?? topics.at(-1))?.text
	}
	return html`
		<${Show} when=${line}>
			<p class="mute recap-line" innerHTML=${() => inline(line(), links)}></p>
		<//>
	`
}
