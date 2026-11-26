/**
 * A bot is one agent in many threads: a home thread, which is its id, a name, the agent it joins as, instructions, and
 * the hue it's shown in if someone picked one. Its name is a label: renaming it changes that one field.
 */
import { createHash } from 'node:crypto'
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
	/** Each bot by its home thread's id, with `home` as a number; a forgotten one keeps only its name, for its threads to show */
	const bots = async () => withHomes((await core.snapshot(Bots)) ?? {})
	const withHomes = (all) =>
		Object.fromEntries(
			Object.entries(all)
				.filter(([, bot]) => !bot.forgotten)
				.map(([home, bot]) => [home, { ...bot, home: Number(home) }]),
		)
	const named = (all, name) => Object.values(withHomes(all)).find((bot) => bot.name === name)
	const list = async (viewer) => {
		const all = await bots()
		// Ordered by home, the keys' own order
		const defaults = new Map(Object.keys(all).map((home, index) => [home, madeHue(index)]))
		const allWork = await core.work()
		return Promise.all(
			Object.entries(all).map(async ([home, { creator: _creator, ...bot }]) => {
				const defaultColor = defaults.get(home)
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
		keyOf: (row) => row.home,
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
	async function write(tx, { name, rename, to, instructions, append, color, projectContext }, by) {
		const all = await tx.doc(Bots)
		let home = named(all, name)?.home
		requireBotEditor(home && all[home], by)
		/** What this write changes, for the step in the bot's home trail */
		const changed = []
		const old = name
		if (rename) {
			if (!home) throw Object.assign(new Error(`No bot ${name}`), { status: 404 })
			if (named(all, rename)) throw new Error(`${rename} is another bot; pick another name`)
			all[home].name = name = rename
			changed.push('name')
		}
		const bot = home && all[home]
		if (!bot) {
			if (!to) throw new Error(`${name} is new: say what it runs as, to: model@runner`)
			// Hands off: a bot leads, and hands the work itself to threads of their own
			home = await core.startThread(tx, name, null, ['-write', '-edit', '-bash'])
			all[home] = { name, to, instructions: instructions ?? '', creator: by }
			await core.trailed(tx, home, undefined, 'bot-created', {
				bot: name,
				to: writtenTo({ ...to, name: undefined }),
			})
		} else {
			if (to) {
				bot.to = to
				changed.push('agent')
			}
			if (instructions !== undefined && instructions !== bot.instructions) {
				bot.instructions = instructions
				changed.push('instructions')
			}
		}
		const now = all[home]
		if (append) {
			now.instructions = [now.instructions, append].filter(Boolean).join('\n')
			if (!changed.includes('instructions')) changed.push('instructions')
		}
		if (changed.length)
			await core.trailed(tx, home, undefined, 'bot-changed', {
				bot: name,
				changed,
				...(rename ? { from: old } : {}),
				...(changed.includes('agent') ? { to: writtenTo({ ...now.to, name: undefined }) } : {}),
				...(changed.includes('instructions') ? { instructions: now.instructions } : {}),
			})
		if (projectContext === false) now.projectContext = false
		else if (projectContext) delete now.projectContext
		if (color === null) delete now.color
		else if (color !== undefined) now.color = color
		const { creator: _creator, ...shown } = now
		return JSON.parse(JSON.stringify({ ...shown, home }))
	}

	const askedHome = (ids, viewer) =>
		Promise.all(
			ids.map(async (thread) => {
				await core.conversation(thread)
				// The question opens the thread and its answer follows: read from the start only until it's there
				const read = []
				for (let cursor; ;) {
					const page = await core.commit((tx) =>
						tx.scanEntries({ conversationId: thread, order: 'ascending' }, 50, cursor),
					)
					read.push(...page.items)
					const first = read.find((entry) => entry.kind === 'ade.message')
					if (first && read.some((entry) => entry.data?.re?.includes(first.id))) break
					if (!(cursor = page.next)) break
				}
				const messages = await core.shapeMessages(thread, core.routed(read), viewer)
				const question = messages[0] ?? null
				const answer =
					(question && messages.find((entry) => entry.data.re?.includes(question.id))) ?? null
				return { thread, question, answer }
			}),
		)
	/** A retry belongs to the person who wrote it, even after a bot was forgotten. */
	const botKey = (action, name, by, key) => {
		const scope = createHash('sha256')
			.update(JSON.stringify([action, name, by]))
			.digest('base64url')
		return core.scopedKey(`bot ${scope.slice(0, 22)}`, key)
	}
	async function serve(id, query, body, by) {
		if (id !== undefined && body === undefined && query.has('asked'))
			return askedHome(query.get('asked').split(',').filter(Boolean).map(Number), by)
		if (id !== undefined)
			throw new Error('Bots live at /api/bots; a home reads the threads that asked with ?asked=1,2')
		if (body === undefined) return list(by)
		requireBotEditor(named(await bots(), body?.name), by)
		const asked = await change(body)
		return core.once(
			botKey('change', asked.name, by, body.key ?? body.requestId),
			`bot ${asked.name}`,
			(tx) => write(tx, asked, by),
		)
	}
	/** Bots made before ade recorded their creator belong to the owner. */
	const requireBotEditor = (bot, by) => {
		if (bot && by !== core.owner && bot.creator !== by)
			throw Object.assign(
				new Error('Only the creator or the owner can change or forget this bot'),
				{
					status: 403,
				},
			)
	}
	const remove = async (name, requestKey, by) => {
		requireBotEditor(named(await bots(), name), by)
		return core.once(botKey('forget', name, by, requestKey), `forget ${name}`, async (tx) => {
			const all = await tx.doc(Bots)
			const home = named(all, name)?.home
			if (!home) throw Object.assign(new Error(`No bot ${name}`), { status: 404 })
			requireBotEditor(all[home], by)
			all[home] = { name, forgotten: true }
			await core.trailed(tx, home, undefined, 'bot-forgotten', { bot: name })
			await core.archiveIn(tx, home)
			return { name, home }
		})
	}

	async function archiving(tx, threadId) {
		const bot = (await tx.doc(Bots))[threadId]
		const name = !bot?.forgotten && bot?.name
		if (name) throw new Error(`Thread ${threadId} is ${name}'s home; forget ${name} first`)
	}

	/** A bot as asking it asks it: its agent as it is now, with its `name` and `home` */
	const asking = (bot) => bot && { ...bot.to, name: bot.name, home: bot.home }
	const botAgent = async (name) => asking(named(await bots(), name))
	const botAt = async (home) => asking((await bots())[home])

	const instructionsOf = async (home) => (await bots())[home]?.instructions
	const botNames = async () => Object.values(await bots()).map((bot) => bot.name)
	const homesOf = async () =>
		Object.fromEntries(Object.entries(await bots()).map(([home, bot]) => [home, bot.name]))
	/** Every bot's name by its home, a forgotten one's too */
	const names = async () =>
		Object.fromEntries(
			Object.entries((await core.snapshot(Bots)) ?? {}).map(([home, bot]) => [home, bot.name]),
		)

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
			if (!at || at.key !== String(at.thread)) throw new Error('Only a bot can, in its home thread')
			const name = args.name ?? at.name
			if (name !== at.name && named(await bots(), name))
				throw new Error(`${name} is another bot; it changes at its own home`)
			const own = await core.agentOf(api.conversationId)
			const asked = await change({
				name,
				instructions: args.instructions,
				append: args.append,
				to: args.model ?? (name === at.name ? undefined : { ...own, name: undefined }),
			})
			const made = await core.once(`bot ${api.taskId}`, 'bot', async (tx) => {
				const roster = await tx.doc(Bots)
				const self = roster[at.thread]
				if (!self || self.forgotten || self.name !== at.name)
					throw new Error('Only a bot can, in its home thread')
				const was = named(roster, name)
				if (name !== at.name && was)
					throw new Error(`${name} is another bot; it changes at its own home`)
				const before = was && {
					instructions: was.instructions,
					model: `${was.to.model}${was.to.thinkingLevel ? `:${was.to.thinkingLevel}` : ''}@${was.to.runner}`,
				}
				// A bot can change itself; a new bot it makes belongs to the same person.
				return {
					...(await write(tx, asked, self.creator ?? core.owner)),
					...(before && { before }),
				}
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
		const all = at && withHomes((await read.snapshot(Bots, context)) ?? {})
		return all?.[at.key] && { at, all, bot: all[at.key] }
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
			const others = Object.values(all)
				.map((bot) => bot.name)
				.filter((name) => name !== at.name)
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
		botAt,
		instructionsOf,
		botNames,
		homesOf,
		names,
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
			const home = named(all, entry.data.author)?.home
			if (home) all[home].answeredAt = entry.data.createdAt
		},
	}
}
