/**
 * A bot is one name in many threads: a home thread, the agent it joins as, instructions, and the hue it's shown in if
 * someone picked one.
 */
import { obj, opt, str } from '@earendil-works/pi-schema'
import { defineDoc, defineExtension, defineTool } from '@earendil-works/pi-durable'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { AGENT, agentTo, writtenTo } from '../util.js'

export const on = true

export const DEFAULT_VOICE =
	'Talk like a person in a chat with friends: lead with the answer, maybe a reaction or a reason, and stop. Everyone here already sees the thread, tool calls and posts; say only what\'s new. No headings, bold or bullets unless asked for a list, and no ids or mechanics unless someone must act on them. If you can check something, check it; if you can\'t, say you\'re guessing.\nWhen you hand work to another agent, keep the brief short: the goal, the boundaries and how to tell it\'s done, not the steps. Aim high and make it measurable ("make this 10x faster", "test it against the old version and close every gap"), not "optimize this".'

const Bots = defineDoc({
	kind: 'ade.bots',
	version: 1,
	scope: 'session',
	checkpointWhen: () => true,
	initial: () => ({}),
})

export function server(core) {
	const madeHue = (index) => Math.round(50 + index * 137.508) % 360
	const bots = () => core.commit(async (tx) => JSON.parse(JSON.stringify(await tx.doc(Bots))))
	const list = async (viewer) => {
		const all = await bots()
		const order = Object.entries(all).sort(([, left], [, right]) => left.home - right.home)
		const defaults = new Map(order.map(([name], index) => [name, madeHue(index)]))
		const allWork = await core.work()
		return Promise.all(
			Object.entries(all).map(async ([name, bot]) => {
				const defaultColor = defaults.get(name)
				const family = core.familyOf(bot.home)
				let working = 0
				let blocked = false
				let errored = false
				let homeDone = false
				for (const { id } of family) {
					const busy = allWork.filter((job) => job.thread === id)
					const state = await core.statusOf(id, busy, viewer)
					if (state === 'working') working++
					else if (state === 'blocked') blocked = true
					else if (state === 'error') errored = true
					else if (state === 'done' && id === bot.home) homeDone = true
				}
				const status = working
					? 'working'
					: blocked
						? 'blocked'
						: errored
							? 'error'
							: homeDone
								? 'done'
								: 'idle'
				return {
					name,
					...bot,
					color: bot.color ?? defaultColor,
					defaultColor,
					customColor: bot.color !== undefined,
					working,
					status,
					answeredAt: bot.answeredAt ?? null,
				}
			}),
		)
	}
	core.feed.define('bots', {
		perViewer: true,
		keyOf: (row) => row.name,
		all: (viewer) => list(viewer),
		match: (change) => {
			if (change.type === 'document')
				return ['ade.bots', 'ade.thread', 'ade.runners', core.agentDocKind].includes(
					change.record.kind,
				)
			if (change.type === 'entry') return change.value.kind === 'ade.message'
			if (change.type === 'task') return core.isWork(change.value.kind)
			if (change.type === 'conversation') return true
			return false
		},
	})

	const voice = core.config?.bots?.voice ?? DEFAULT_VOICE

	async function valid(name) {
		if (typeof name !== 'string' || !/^[\w.-]{1,40}$/.test(name))
			throw new Error('A name is 1 to 40 letters, digits, _ . or -')
		if ((await core.known())[name]) throw new Error(`${name} is a runner; pick another name`)
		if (name === core.owner) throw new Error(`${name} is the owner's name; pick another name`)
		if (name === AGENT)
			throw new Error(`${AGENT} is what every thread calls its own; pick another name`)
	}
	async function change({
		name,
		rename = undefined,
		to,
		instructions,
		append = undefined,
		color = undefined,
		projectContext = undefined,
	}) {
		await valid(name)
		if (rename !== undefined && rename !== name) await valid(rename)
		else rename = undefined
		if (instructions !== undefined && typeof instructions !== 'string')
			throw new Error('instructions is text')
		if (append !== undefined && (typeof append !== 'string' || !append.trim()))
			throw new Error('append is a line of text')
		if (projectContext !== undefined && typeof projectContext !== 'boolean')
			throw new Error('projectContext is true or false')
		if (
			color !== undefined &&
			color !== null &&
			!(Number.isFinite(color) && color >= 0 && color < 360)
		)
			throw new Error('color is a hue from 0 to 360, or null for the one it would have')
		if (to !== undefined) {
			const { name: _, ...agent } = await core.address(typeof to === 'string' ? agentTo(to) : to)
			// Kept whole, so it stays the same folder when its runner starts in another
			if (agent.dir) agent.dir = core.folder((await core.known())[agent.runner], agent)
			to = agent
		}
		return { name, rename, to, instructions, append: append?.trim(), color, projectContext }
	}
	/** `ids`, every thread, read before the commit: a rename moves the bot's agent in each one it's in */
	async function write(
		tx,
		{ name, rename, to, instructions, append, color, projectContext },
		ids = [],
	) {
		const all = await tx.doc(Bots)
		/** What this write changes, for the step in the bot's home trail */
		const changed = []
		const old = name
		if (rename) {
			if (!all[name]) throw Object.assign(new Error(`No bot ${name}`), { status: 404 })
			if (all[rename]) throw new Error(`${rename} is another bot; pick another name`)
			await core.renameIn(tx, ids, name, rename)
			all[rename] = JSON.parse(JSON.stringify(all[name]))
			delete all[name]
			changed.push('name')
			name = rename
		}
		if (!all[name]) {
			if (!to) throw new Error(`${name} is new: say what it runs as, to: model@runner`)
			const home = await core.startThread(tx, name, null)
			all[name] = { home, to, instructions: instructions ?? '' }
			await core.trailed(tx, home, undefined, 'bot-created', {
				bot: name,
				to: writtenTo({ ...to, name: undefined }),
			})
		} else {
			if (to) {
				all[name].to = to
				changed.push('agent')
			}
			if (instructions !== undefined && instructions !== all[name].instructions) {
				all[name].instructions = instructions
				changed.push('instructions')
			}
		}
		if (append) {
			all[name].instructions = [all[name].instructions, append].filter(Boolean).join('\n')
			if (!changed.includes('instructions')) changed.push('instructions')
		}
		if (changed.length)
			await core.trailed(tx, all[name].home, undefined, 'bot-changed', {
				bot: name,
				changed,
				...(rename ? { from: old } : {}),
				...(changed.includes('agent')
					? { to: writtenTo({ ...all[name].to, name: undefined }) }
					: {}),
				...(changed.includes('instructions') ? { instructions: all[name].instructions } : {}),
			})
		if (projectContext === false) all[name].projectContext = false
		else if (projectContext) delete all[name].projectContext
		if (color === null) delete all[name].color
		else if (color !== undefined) all[name].color = color
		return JSON.parse(JSON.stringify({ name, ...all[name] }))
	}

	const askedHome = (ids, viewer) =>
		Promise.all(
			ids.map(async (thread) => {
				const messages = await core.shapeMessages(thread, await core.messages(thread), viewer)
				const question = messages[0] ?? null
				const answer =
					(question && messages.find((entry) => entry.data.re?.includes(question.id))) ?? null
				return { thread, question, answer }
			}),
		)
	async function serve(id, query, body, by) {
		if (id !== undefined && body === undefined && query.has('asked'))
			return askedHome(query.get('asked').split(',').filter(Boolean).map(Number), by)
		if (id !== undefined)
			throw new Error('Bots live at /api/bots; a home reads the threads that asked with ?asked=1,2')
		if (body === undefined) return list(by)
		const asked = await change(body)
		const ids = asked.rename ? await core.threadIds() : []
		return core.once(
			core.scopedKey(`bot ${asked.name}`, body.key ?? body.requestId),
			`bot ${asked.name}`,
			(tx) => write(tx, asked, ids),
		)
	}
	const remove = (name, requestKey) =>
		core.once(core.scopedKey(`forget ${name}`, requestKey), `forget ${name}`, async (tx) => {
			const all = await tx.doc(Bots)
			if (!all[name]) throw Object.assign(new Error(`No bot ${name}`), { status: 404 })
			const { home } = all[name]
			delete all[name]
			await core.trailed(tx, home, undefined, 'bot-forgotten', { bot: name })
			await core.archiveIn(tx, home)
			return { name, home }
		})

	async function archiving(tx, threadId) {
		const [name] = Object.entries(await tx.doc(Bots)).find(([, bot]) => bot.home === threadId) ?? []
		if (name) throw new Error(`Thread ${threadId} is ${name}'s home; forget ${name} first`)
	}

	async function botAgent(name) {
		const bot = (await bots())[name]
		return bot && { ...bot.to, name }
	}

	const instructionsOf = async (name) => (await bots())[name]?.instructions
	const botNames = async () => Object.keys(await bots())
	const homesOf = async () =>
		Object.fromEntries(Object.entries(await bots()).map(([name, bot]) => [bot.home, name]))

	const bot = defineTool({
		name: 'bot',
		description:
			'Only for a bot, in its home thread. Leave out `name`, or give your own, to rewrite yourself: your instructions, ' +
			'which every agent of your name reads, or the model you join new threads with. To add a lesson, `append` it ' +
			'rather than resending the whole text. A new name makes another bot, with its own home thread, from your model ' +
			'unless you give one.',
		parameters: obj({
			name: opt(str({ description: 'A new bot to make; leave out for yourself' })),
			instructions: opt(
				str({
					description:
						'The whole text: who the bot is, how it works, what it knows about the people it works with',
				}),
			),
			append: opt(str({ description: 'A line to add to the end of your instructions' })),
			model: opt(str({ description: 'model@runner, as `pi --model` takes the model' })),
		}),
		replay: 'safe',
		execute: async (input, api) => {
			const args = /** @type {any} */ (input)
			const at = await core.home(api.conversationId)
			const all = await bots()
			if (!at || all[at.name]?.home !== at.thread)
				throw new Error('Only a bot can, in its home thread')
			const name = args.name ?? at.name
			if (name !== at.name && all[name])
				throw new Error(`${name} is another bot; it changes at its own home`)
			const own = await core.agentOf(api.conversationId)
			const asked = await change({
				name,
				instructions: args.instructions,
				append: args.append,
				to: args.model ?? (name === at.name ? undefined : { ...own, name: undefined }),
			})
			const made = await core.once(`bot ${api.taskId}`, 'bot', async (tx) => {
				const was = (await tx.doc(Bots))[name]
				const before = was && {
					instructions: was.instructions,
					model: `${was.to.model}${was.to.thinkingLevel ? `:${was.to.thinkingLevel}` : ''}@${was.to.runner}`,
				}
				return { ...(await write(tx, asked)), ...(before && { before }) }
			})
			return {
				...(name === at.name && { details: { before: made.before } }),
				output: [
					{
						type: 'text',
						text:
							name === at.name
								? 'Done: it counts from your next request.'
								: `Made ${name}, at home in thread ${made.home}.`,
					},
				],
			}
		},
	})

	/** The agent's bot, in its section and the one after it with its threads and the other bots, which change most */
	const botOf = async ({ conversationId, read }) => {
		const at = await core.home(conversationId)
		const all = at && ((await read.snapshot(Bots, context)) ?? {})
		return all?.[at.name] && { at, all, bot: all[at.name] }
	}
	const section = {
		key: 'bot',
		render: async (input) => {
			const { at, bot } = (await botOf(input)) ?? {}
			if (!bot) return undefined
			const home = at.thread === bot.home
			return [
				voice,
				bot.instructions ||
					(home
						? "You're new: you have no instructions yet. Find out with the person here who you are, and write it down with your bot tool."
						: ''),
				`You are the bot ${at.name}, one person in every thread you're in.`,
				home && 'This is your home. Ask before you change your model.',
			]
				.filter(Boolean)
				.join('\n\n')
		},
	}
	const around = {
		key: 'bot-threads',
		tag: false,
		render: async (input) => {
			const { at, all, bot } = (await botOf(input)) ?? {}
			if (!bot) return undefined
			const threads = (await core.threadList(at.name)).filter(
				(thread) =>
					thread.id !== at.thread && thread.agents.some((agent) => agent.name === at.name),
			)
			const where = threads.map(
				(thread) => `${thread.id} "${thread.title}"${thread.id === bot.home ? ' (home)' : ''}`,
			)
			const others = Object.keys(all).filter((name) => name !== at.name)
			// Empty rather than gone, so it keeps its place when a thread joins
			return [
				where.length &&
					`You're also in thread${where.length > 1 ? 's' : ''} ${where.join(', ')}; ${core.modulesOn?.includes('recap') ? "check one's recap to see where it stands, read it for detail, " : 'read one when it matters, '}and post to one to speak there yourself.`,
				others.length &&
					input.agent.tools.some((tool) => tool.name === 'post') &&
					`The other bot${others.length > 1 ? 's are' : ' is'} ${others.join(', ')}: post with \`to\` set to a name to ask one.`,
			]
				.filter(Boolean)
				.join('\n\n')
		},
	}
	/** A bot with `projectContext: false` reads its folder's skills, but not its AGENTS.md files */
	const withoutProject = (project) => ({
		...project,
		render: async (input, context) => {
			const text = await project.render(input, context)
			if (typeof text !== 'string' || (await botOf(input))?.bot.projectContext !== false)
				return text
			const end = text.lastIndexOf('</project_context>')
			return end < 0 ? text : text.slice(end + '</project_context>'.length).replace(/^\n+/, '')
		},
	})
	return {
		serve,
		remove,
		archiving,
		botAgent,
		instructionsOf,
		botNames,
		homesOf,
		settings: { voice },
		extension: defineExtension({
			name: 'ade.bots',
			tools: [bot],
			sections: [section, around],
			wraps: [{ section: 'project', wrap: withoutProject }],
		}),
		/** Its sections change most, so they come last in the prompt */
		volatility: 2,
		async posted(tx, threadId, entry) {
			if (!entry.data.answer) return
			const all = await tx.doc(Bots)
			if (all[entry.data.author]) all[entry.data.author].answeredAt = entry.data.createdAt
		},
	}
}
