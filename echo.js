/** Scripted echo responses for the scratch server; the runner and its tools are real. */
import {
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	fauxText,
} from '@earendil-works/pi-ai/providers/faux'
import { messageText as text } from './remote.js'
const say = (text) => fauxAssistantMessage([fauxText(text)])
const call = (name, args) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' })
export const personas = {
	bot1: 'a careful reviewer',
	bot2: 'a blunt engineer',
	bot3: 'a curious designer',
}
/** A bot's reply: its name and persona, how many messages it was just handed, and the newest of them */
const bots = (request) => {
	const system = JSON.stringify(request.messages.filter((m) => m.role === 'system'))
	const name = /You are the bot (\w+)/.exec(system)?.[1]
	if (!name || request.messages.at(-1).role !== 'user') return undefined
	/** A person's words come as typed and everyone else's inside a <message> tag, a blank line between messages */
	const handed = text(request.messages.at(-1))
		.split(/\n\n(?=<message from=")|(?<=\n<\/message>)\n\n/)
		.filter(Boolean)
	const newest = (handed.at(-1) ?? '').replace(/\n/g, ' ').slice(0, 120)
	return say(`${name} (${personas[name]}) got ${handed.length}, newest "${newest}"`)
}
/** The director's pick: the bot whose persona's last word the new messages use, else nobody */
const director = (request) => {
	const ask = text(request.messages.at(-1))
	const message = (
		ask.split(/New messages?:\n/)[1]?.split('\n\nCandidates:')[0] ?? ''
	).toLowerCase()
	if (/\b(you all|everyone|all of you)\b/.test(message))
		return say(JSON.stringify({ choice: 'all', confidence: 0.9, reason: 'they asked everyone' }))
	const name = Object.keys(personas).find((name) =>
		message.includes(personas[name].split(' ').pop().slice(0, 6)),
	)
	return say(
		JSON.stringify(
			name
				? {
						choice: name,
						confidence: 0.8,
						reason: `it's about ${personas[name].split(' ').pop()}s`,
					}
				: { choice: 'nobody', confidence: 0.7, reason: 'nothing for them' },
		),
	)
}
const recap = (request) => {
	const [, at, who, said] =
		[...text(request.messages.at(-1)).matchAll(/^\[(\d+)\] (\S+)[^:]*: (.*)$/gm)].at(-1) ?? []
	return say(at ? `- [ ] ${who}: ${said.slice(0, 60)} [#${at}](#message-${at})` : '')
}
export const tryEcho = (request) => {
	if (text(request.messages[0] ?? { content: '' }).startsWith('You choose who answers'))
		return director(request)
	if (text(request.messages[0] ?? { content: '' }).startsWith('# Recap')) return recap(request)
	const latest = request.messages.at(-1)
	if (latest.role === 'user' && text(latest).startsWith('bot append '))
		return call('bot', { append: text(latest).slice(11) })
	if (latest.role === 'user' && text(latest).startsWith('bot '))
		return call('bot', { instructions: text(latest).slice(4) })
	// "think <text>" thinks it, then answers in a word: a turn that is only a thought
	if (latest.role === 'user' && /(?:^|\n)think /.test(text(latest)))
		return fauxAssistantMessage([
			fauxThinking(
				text(latest)
					.split(/(?:^|\n)think /)
					.pop()
					.replace(/\n<\/message>$/, ''),
			),
			fauxText('Thought about it.'),
		])
	// "fail" makes the run fail, as a model error would
	if (latest.role === 'user' && text(latest).trim() === 'fail')
		return fauxAssistantMessage([], {
			stopReason: 'error',
			errorMessage: 'the model failed, on purpose',
		})
	// "ask <question>" asks the person, with inbox on
	if (latest.role === 'user' && text(latest).startsWith('ask '))
		return call('ask_person', { body: text(latest).slice(4) })
	if (latest.role === 'toolResult' && latest.toolName === 'ask_person')
		return say('Asked; waiting for your answer.')
	// "search <words>" searches every thread, with search on, and answers what it found
	if (latest.role === 'user' && text(latest).startsWith('search '))
		return call('search', { query: text(latest).slice(7) })
	if (latest.role === 'toolResult' && latest.toolName === 'search') return say(text(latest))
	// "schedule on hook <instructions>" schedules a task on an outside event, with schedule and hooks on, and answers where it posts
	const hooked =
		latest.role === 'user' &&
		/(?:^|<message from="[^"]*">\n)schedule on (\S+) (.+?)(?:\n<\/message>)?$/s.exec(text(latest))
	if (hooked) return call('schedule', { on: hooked[1], instructions: hooked[2] })
	if (
		latest.role === 'toolResult' &&
		latest.toolName === 'schedule' &&
		text(latest).includes('/hooks/')
	)
		return say(text(latest))
	// "schedule mon,tue 09:00,17:30 <instructions>" (or daily) schedules by the clock; "schedule 5m …" or "schedule every 1m …" after a while
	const clocked =
		latest.role === 'user' &&
		/(?:^|<message from="[^"]*">\n)schedule (daily|[a-z,]+) (\d{1,2}:\d{2}(?:,\d{1,2}:\d{2})*) (.+?)(?:\n<\/message>)?$/s.exec(
			text(latest),
		)
	if (clocked)
		return call('schedule', {
			times: clocked[2].split(','),
			...(clocked[1] === 'daily' ? {} : { days: clocked[1].split(',') }),
			instructions: clocked[3],
		})
	const timed =
		latest.role === 'user' &&
		/(?:^|<message from="[^"]*">\n)schedule (every )?(\S+) (.+?)(?:\n<\/message>)?$/s.exec(
			text(latest),
		)
	if (timed)
		return call('schedule', { [timed[1] ? 'every' : 'in']: timed[2], instructions: timed[3] })
	if (latest.role === 'toolResult' && latest.toolName === 'schedule')
		return say(latest.isError ? `failed: ${text(latest)}` : 'Scheduled.')
	// "hands" runs `uname -n; pwd` on every online runner in one turn; "hands slow" sleeps first
	const hands = request.messages.findLast(
		(m) => m.role === 'user' && /(?:^|\n)hands\b/.test(text(m)),
	)
	if (hands && latest === hands) return call('runners', {})
	if (hands && latest.role === 'toolResult' && latest.toolName === 'runners')
		return fauxAssistantMessage(
			text(latest)
				.split('\n')
				.filter((line) => line.includes(', online'))
				.map((line) =>
					fauxToolCall('bash', {
						command: `${/hands slow/.test(text(hands)) ? 'sleep 5; ' : ''}uname -n; pwd`,
						runner: line.split(',')[0],
					}),
				),
			{ stopReason: 'toolUse' },
		)
	if (hands && latest.role === 'toolResult' && latest.toolName === 'bash') {
		const since = request.messages.indexOf(hands)
		return say(
			request.messages
				.slice(since)
				.filter((m) => m.role === 'toolResult' && m.toolName === 'bash')
				.map((m) => text(m).trim())
				.join('\n---\n'),
		)
	}
	// "shell <command>" runs it in bash and answers with what it printed
	const shell = request.messages.findLast((m) => m.role === 'user')
	if (shell && text(shell).startsWith('shell ')) {
		if (latest === shell) return call('bash', { command: text(shell).slice('shell '.length) })
		if (latest.role === 'toolResult') return say(text(latest).trim())
	}
	const bot = bots(request)
	if (bot) return bot
	const last = request.messages.findLastIndex((m) => m.role === 'user')
	const asked = text(request.messages[last])
	if (latest.role === 'toolResult' && latest.toolName === 'bot') return say('Instructions changed.')
	const n = request.messages.slice(last).filter((m) => m.role === 'toolResult').length
	if (n === 0)
		return fauxAssistantMessage(
			[
				fauxThinking(
					`They said "${asked.slice(0, 80)}".\nI'll start a notes file, then look around.`,
				),
				fauxToolCall('write', {
					path: 'notes.md',
					content: `# Notes\n\nasked: ${asked.slice(0, 80)}\n`,
				}),
			],
			{ stopReason: 'toolUse' },
		)
	if (n === 1) return call('read', { path: 'notes.md' })
	if (n === 2)
		return call('edit', {
			path: 'notes.md',
			edits: [{ oldText: '# Notes', newText: '# Notes, edited' }],
		})
	if (n === 3)
		return call('bash', {
			command: `${asked.includes('slow') ? 'sleep 5; ' : ''}ls -la; cat notes.md`,
		})
	if (n === 4 && asked.includes('post') && !/<message from="[^"]*" agent thread=/.test(asked))
		return call('post', {
			// "post to 12" follows up in thread 12 instead of starting one
			...(asked.match(/post to (\d+)/)
				? { thread: Number(asked.match(/post to (\d+)/)[1]) }
				: { title: 'side question' }),
			body: `${asked.includes('slow') ? 'slow: ' : ''}what did you find?`,
			// "post bot1" asks the bot bot1 instead
			to: Object.keys(personas).find((name) => asked.includes(name)) ?? 'echo/try@bot',
		})
	return say(
		`Done. I wrote, read and edited \`notes.md\`, then ran a command:\n\n\`\`\`\n${text(request.messages.at(-1)).slice(0, 400)}\n\`\`\`\n\n- one\n- two`,
	)
}
