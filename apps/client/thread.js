/** A thread owns its message subscription while it is on screen. */
import html from '@solidjs/html'
import { Icon } from './icons.js'
import {
	createEffect,
	createMemo,
	createProjection,
	createRoot,
	createSignal,
	createStore,
	For,
	getOwner,
	onSettled,
	reconcile,
	runWithOwner,
	Show,
	Switch,
	Match,
	untrack,
} from 'solid-js'
import {
	api,
	bots,
	closeColumn,
	colorOf,
	columns,
	current,
	earlier,
	entries,
	familyOf,
	loadEarlier,
	openThreadFeed,
	pagers,
	prependOlder,
	fork,
	followThread,
	forkedFrom,
	homeBot,
	hrefOf,
	newThreadTools,
	openThread,
	server,
	threadRows,
	titleOf,
	watch,
	threadOf,
} from './server.js'
import { authorLabel, doing, setDoing, shortLabel } from './agent.js'
import {
	answersIn,
	askedThread,
	Changed,
	conversations,
	cutOf,
	Exchange,
	heard,
	lastingOf,
	litIn,
	newestCut,
	timesOf,
	Turn,
	turnsOf,
} from './run.js'
import { Break, breakOf, Stamp } from './time.js'
import { appendQuote, Composer } from './composer.js'
import { copyText, nativeMenu, selectedIn } from './desktop.js'
import { threadMenu } from './thread-list.js'
import { Dot } from './dot.js'
import { report } from './notice.js'
import { imageUrl } from './images.js'
import { markdown } from './markdown.js'
import { messageDiagrams } from './mermaid.js'
import { sideOf, toggleSide } from './side.js'
import { heardActivity } from './director.js'
import { CanvasRow } from './canvas.js'
import { ScheduledRun, ScheduledTaskSet } from './schedule.js'

/** A folded summary's text, without the literal <summary> wrapper tags some memories still carry */
const stripSummaryTag = (text) =>
	(text ?? '').replace(/^\s*<\/?summary>\s*\n?/im, '').replace(/\n\s*<\/?summary>\s*$/im, '')

/** Its first line of words, without the markdown around them, to stand for it folded */
const firstLine = (text) =>
	(
		stripSummaryTag(text)
			.split('\n')
			.find((line) => line.trim()) ?? ''
	)
		.replace(/^\s*(#+|[-*>]|\d+\.)\s*/, '')
		.replace(/[*_`]/g, '')
		.trim()

/** Each asked thread's first message, the question, and its answer if it had one yet, for the home of the bot it asks; `null` when it isn't one */
const [questions, setQuestions] = createStore({}, { shallow: true })
/** Each asked thread's latest look, with its status then; an unanswered one is looked at again when that moves */
const fetched = new Map()
/** Rows a thread opens on; as many more come each time you scroll near the top */
const SHOWN = 40

export function Thread(props) {
	const thread = createMemo(() => threadOf(props.id))
	const messages = () => entries[props.id] ?? []
	/** The forks made from any message shown here, by `thread entry`; a fork is in its source's family, so only the family is read */
	const forks = createMemo(() => {
		const at = new Map()
		for (const member of familyOf(props.id)) {
			const fork = threadOf(member.id)
			const from = forkedFrom(fork)
			if (!from || fork.archived) continue
			const key = `${from} ${fork.conversation.parent.at}`
			at.set(key, [...(at.get(key) ?? []), fork])
		}
		return at
	})
	/** Each message's position in the thread, from 0, as memory and the recap count them */
	const positions = createMemo(() => new Map(messages().map((entry, at) => [entry.id, at])))
	/** In a bot's home, the threads others asked it in: it's their one agent, and they started outside its family. A room has more than one. */
	const askedHere = createMemo(() => {
		const bot = homeBot(props.id)
		if (!bot) return []
		const family = new Set(familyOf(props.id).map((member) => member.id))
		return threadRows().open.filter(
			(other) =>
				other.parent !== null &&
				!family.has(other.id) &&
				other.agents.length === 1 &&
				other.agents[0].name === bot.name,
		)
	})
	// Fetched once, and again while unanswered each time the asked thread's status moves, as it does when the answer lands:
	// every thread that moved in one read
	createEffect(
		() =>
			askedHere()
				.filter((other) => questions[other.id] !== null && !questions[other.id]?.answer)
				.map((other) => `${other.id} ${other.status}`),
		(seen) => {
			const looks = new Map()
			for (const [id, status] of seen.map((key) => key.split(' '))) {
				if (fetched.get(id)?.status === status) continue
				const look = { status }
				fetched.set(id, look)
				looks.set(id, look)
			}
			if (!looks.size) return
			api(`/api/threads/${props.id}/bots?asked=${[...looks.keys()].join(',')}`)
				.then((found) => {
					for (const { thread, question, answer } of found) {
						const id = String(thread)
						// A look that a newer one overtook would write what it saw over what that one found
						if (fetched.get(id) !== looks.get(id)) continue
						// Asked a moment ago, its question may not be in yet; the next look asks again
						if (!question) {
							fetched.delete(id)
							continue
						}
						setQuestions((all) => {
							all[id] = question.data.from ? { question, answer: answer ?? undefined } : null
						})
					}
				})
				.catch(report)
		},
	)
	const [unfolded, setUnfolded] = createSignal(false)
	const [openedGaps, setOpenedGaps] = createStore({})
	/** Where the messages on screen start: the oldest one, while there are more before it */
	const start = createMemo(() =>
		earlier[props.id] ? (messages().find((entry) => !entry.sending)?.id ?? 0) : -Infinity,
	)
	/** Each agent's turns and cuts, worked out again only when its own conversation grows, not when a message lands */
	const owner = getOwner()
	const memos = new Map()
	const perConversation = (conversation) => {
		if (!memos.has(conversation))
			runWithOwner(owner, () =>
				memos.set(conversation, {
					turns: createMemo(() => turnsOf(conversation)),
					cut: createMemo(() => cutOf(conversation)),
					times: createMemo(() => timesOf(conversation)),
				}),
			)
		return memos.get(conversation)
	}
	/**
	 * The thread's messages with each agent turn after the last message its delivery held, and a live one while it works.
	 * A turn that only answered is its answer; an answer to a post shows in the post.
	 */
	let built = new Map()
	/** The newest compaction's cut, once the messages on screen reach it */
	const cut = createMemo(() => {
		const newest = newestCut(
			(thread()?.agents ?? []).map((agent) => perConversation(agent.conversation).cut()),
		)
		return newest && newest.at >= start() ? newest : null
	})
	/** Scrolled near the top, the rows above come, then the page before, unless what's above is folded into memory lines */
	const nearTop = () => {
		if (!list || scrollMode.kind === 'gliding' || list.scrollTop >= list.clientHeight) return
		const top = rows.findIndex((row) => row.at >= (shownFrom() ?? -Infinity))
		if (top > 0) {
			hold()
			return setShownFrom(rows[Math.max(0, top - SHOWN)].at)
		}
		if (earlier[props.id] && (!cut() || unfolded())) loadEarlier(props.id)
	}
	const rows = createProjection(
		() => {
			const all = messages()
			const agents = thread()?.agents ?? []
			const turns = agents.flatMap((agent) => {
				const live = doing[props.id]?.[agent.conversation]
				const turns = perConversation(agent.conversation)
					.turns()
					.map((turn) => ({
						key: turn.key,
						agent,
						turn,
						at: turn.after + 0.5,
						time: turn.start,
						live: !!live?.run && live.delivery?.id === turn.delivery,
					}))
				// Asked while its runner is offline, before any delivery
				if (agent.status === 'blocked' && !live?.run)
					turns.push({
						key: `${agent.conversation}:waiting`,
						agent,
						at: (all.at(-1)?.id ?? 0) + 0.5,
						live: true,
					})
				// A turn that only answered is its answer
				return turns.filter(
					(row) => row.live || !row.turn || row.turn.steps.some((step) => step.label !== 'handed'),
				)
			})
			const answerOf = answersIn(all)
			/** When a message was written: its own time, else, from before messages carried one, when its agent answered it or was asked by it */
			const timeOf = (entry) => {
				if (entry.data.createdAt) return Date.parse(entry.data.createdAt)
				const answer = entry.data.answer
				if (answer) return perConversation(answer.conversation).times().said.get(answer.entry)
				const times = agents
					.map((agent) => perConversation(agent.conversation).times().asked.get(entry.id))
					.filter((time) => time !== undefined)
				return times.length ? Math.min(...times) : undefined
			}
			// An answer to an ask line shows in it; one with no line stays a message
			const answers = new Set(
				turns.flatMap((row) => (row.turn ? row.turn.steps.map((step) => answerOf(step)?.id) : [])),
			)
			const shown = all.filter((entry) => !answers.has(entry.id) && !entry.data.withdrawn)
			// Your message sent while an agent works waits for it to pick it up, and until then you can take it back
			const working = agents.some((agent) => doing[props.id]?.[agent.conversation]?.run)
			const handedUpTo = Math.max(
				-1,
				...agents.flatMap((agent) => [
					...(perConversation(agent.conversation).turns().at(-1)?.held ?? []),
					...(doing[props.id]?.[agent.conversation]?.delivery?.held ?? []),
				]),
			)
			const waiting = ({ id, sending, voice, data }) =>
				working && !sending && id > handedUpTo && voice === 'mine' && !data.shell
			// What a turn changed beyond itself, each on its own row after it: an ask, with its answer, or a bot rewriting itself
			const lasting = turns
				.filter((row) => row.turn)
				.flatMap((row) =>
					lastingOf(row.turn.steps).map((step, index) => {
						const at = row.at + (index + 1) / 1000
						const time = step.result.time
						const kind =
							{ canvas_act: 'drew', schedule: 'scheduled', post: 'ask' }[step.name] ?? 'changed'
						if (kind !== 'ask')
							return {
								key: `${row.key}:${step.name}:${step.key}`,
								[kind]: step,
								agent: row.agent,
								at,
								time,
							}
						const answer = answerOf(step) || undefined
						const back =
							answer &&
							perConversation(row.agent.conversation)
								.turns()
								.find((turn) => turn.held.includes(answer.id))?.start
						const otherThread = askedThread(step)
						const otherAuthor =
							answer?.data.author ??
							homeBot(otherThread)?.name ??
							threadOf(otherThread)?.agents?.[0]?.name ??
							step.args.to ??
							''
						return {
							key: `${row.key}:ask:${step.key}`,
							ask: step,
							agent: row.agent,
							answer,
							back,
							at,
							time,
							voice: 'sent',
							otherAuthor,
							otherThread,
							otherLabel: titleOf(otherThread),
							otherModel: shortLabel(otherAuthor),
							fresh: step.args.thread === undefined,
						}
					}),
				)
			const forkMap = forks()
			const shapeEntry = (entry, threadId) => ({
				entry,
				home: props.id,
				...(threadId !== props.id && { thread: threadId }),
				at: entry.id,
				time: timeOf(entry),
				voice: entry.voice,
				speaker: entry.speaker,
				name: entry.showName ? entry.speaker : undefined,
				to: entry.to,
				otherAuthor: entry.otherAuthor,
				otherThread: entry.otherThread,
				otherLabel: entry.otherLabel,
				clamp: entry.clamp,
				failed: entry.failed,
				picked: entry.picked,
				pickedNobody: entry.pickedNobody,
				forks: forkMap.get(`${threadId} ${entry.id}`),
			})
			// A question from another thread, where it came in, on one line that opens to it; the bot's answer follows as its
			// own message, which lives in the thread that asked
			const asked = askedHere().flatMap((other) => {
				const got = questions[other.id]
				if (!got) return []
				const otherAuthor = got.question.speaker ?? got.question.data.author
				const question = {
					key: `asked:${other.id}`,
					asked: other.id,
					question: got.question,
					at: got.question.id,
					time: timeOf(got.question),
					voice: 'received',
					otherAuthor,
					otherThread: other.id,
					otherLabel: shortLabel(otherAuthor),
				}
				const answer = got.answer && {
					key: `asked:${other.id}:${got.answer.id}`,
					...shapeEntry(got.answer, other.id),
				}
				return answer ? [question, answer] : [question]
			})
			const said = shown.map((entry) => ({
				key: entry.sentAt != null ? `local:${entry.sentAt}` : entry.id,
				...shapeEntry(entry, props.id),
				waiting: waiting(entry),
			}))
			// One cut line, the newest compaction's; what the agent reads as lines folds into them, unless opened from it
			const newest = cut()
			const folded = newest && !unfolded() ? newest : null
			// Only what lies among the messages on screen; older rows come with their page
			const shows = (row) => row.at >= start() && !(folded && row.at < folded.at)
			const lines = folded ? folded.lines.map((line) => ({ ...line, line: true })) : []
			const rows = [
				...said.filter(shows),
				...turns.filter(shows),
				...lasting.filter(shows),
				...asked.filter(shows),
				...lines,
				...(newest ? [newest] : []),
			].sort((one, other) => one.at - other.at)
			// Local day/hour breaks, plus hoisting a message's break/name onto the agent turn right above it
			let before, lastSpeaker
			for (const [index, row] of rows.entries()) {
				if (row.entry) {
					row.break = breakOf(before?.time, row.time)
					before = row
					if (row.break && row.voice === 'said' && row.speaker) row.name = row.speaker
					const prev = rows[index - 1]
					if ((prev?.turn || prev?.live) && prev.agent?.name === row.speaker) {
						if (row.break) [prev.break, row.break] = [row.break, undefined]
						if (row.name) [prev.name, row.name] = [row.name, undefined]
					}
					lastSpeaker = ['sent', 'received', 'run'].includes(row.voice)
						? undefined
						: row.voice === 'mine'
							? lastSpeaker
							: row.speaker
				} else if (row.turn || row.live) {
					const next = rows[index + 1]
					if (!(next?.entry && next.speaker === row.agent?.name)) {
						if (row.agent?.name && row.agent.name !== lastSpeaker) row.name = row.agent.name
						if (row.agent?.name) lastSpeaker = row.agent.name
					}
				}
			}
			// A row that didn't change is handed back as the same object, so the diff skips it and an update costs the rows it touched
			const next = new Map()
			const reused = rows.map((row) => {
				const before = built.get(row.key)
				const same =
					before &&
					Object.keys(row).length === Object.keys(before).length &&
					Object.keys(row).every((key) => row[key] === before[key])
				next.set(row.key, same ? before : row)
				return same ? before : row
			})
			built = next
			return reused
		},
		[],
		{ key: 'key' },
	)
	/** The list waits for its messages and each agent's conversation, so it shows folded at once instead of shifting */
	const ready = () =>
		!!entries[props.id] &&
		(thread()?.agents ?? []).every((agent) => conversations[agent.conversation])
	/**
	 * Where the rows on screen start, by `at`: a thread opens on its newest SHOWN rows, and those above come in as you
	 * scroll up, so a long thread costs its end, not all it has. `null` until the first rows are laid out.
	 */
	const [shownFrom, setShownFrom] = createSignal(null)
	const onScreen = createMemo(() => {
		if (!ready()) return []
		const from = shownFrom() ?? (rows.at(-SHOWN) ?? rows[0])?.at ?? -Infinity
		return rows.filter((row) => row.at >= from)
	})
	/** Once the first rows are laid out, where they start stays put: a message landing below adds a row instead of moving the top */
	createEffect(
		() => (ready() && rows.length ? ((rows.at(-SHOWN) ?? rows[0])?.at ?? -Infinity) : null),
		(start) => {
			if (start !== null) setShownFrom((from) => from ?? start)
		},
	)
	const titleClick = () =>
		current() !== props.id ? openThread(props.id) : toggleSide(props.id, 'details')
	let list,
		room,
		followed,
		sizes,
		changes,
		/** One scroll mode at a time: following, gliding, holding, anchoring, or detached. */
		scrollMode = { kind: 'following' },
		/** Your last message's row and how much of the view the answer gets under it, decided once when you send */
		answerRoom = null,
		/** Temporary padding added under a closed <details> near the bottom */
		padded = false,
		bottom = () => {},
		hold = () => {},
		startGlide = () => {}
	const setScrollMode = (next) => {
		if (scrollMode.kind === 'gliding') scrollMode.cancel()
		scrollMode = next
	}
	const atBottom = () =>
		Boolean(list && list.scrollTop + list.clientHeight >= list.scrollHeight - 4)
	/** Back from a glide, hold or anchor: following if the view ends at the bottom, else left where the reader is */
	const settle = () => setScrollMode({ kind: atBottom() ? 'following' : 'detached' })
	onSettled(() => () => {
		setScrollMode({ kind: 'detached' })
		sizes?.disconnect()
		changes?.disconnect()
	})
	/** Marks the thread read for me, but only while I'm actually looking: a hidden tab shouldn't clear the dot for an answer nobody saw */
	const markRead = (id) => {
		if (document.visibilityState === 'visible') api(`/api/threads/${id}/read`, {}).catch(report)
	}
	// New messages arriving on the `thread/<id>` feed: stick to bottom on your own send, and mark read for others'
	createEffect(
		() => {
			const id = props.id
			const last = (entries[id] ?? []).findLast((entry) => !entry.sending)
			return id && last ? `${id}:${last.id}:${last.voice}` : null
		},
		(latest, previous) => {
			if (!latest || !previous || latest.split(':')[0] !== previous.split(':')[0]) return
			const [id, , voice] = latest.split(':')
			if (voice === 'mine' && scrollMode.kind === 'detached') setScrollMode({ kind: 'following' })
			markRead(Number(id))
		},
	)
	createEffect(
		() => props.id,
		(id) => {
			if (!id) return
			let socket,
				asking = null,
				turnsDone = () => {}
			/** Agents whose conversation came on this watch; the next batch from each is appended */
			const heardFrom = new Set()
			const releaseFeed = openThreadFeed(id)
			const finishTurns = () => {
				turnsDone()
				turnsDone = () => {}
			}
			pagers.set(id, (all) => {
				// Asked for all of it, every row shows, even those already here
				if (all) setShownFrom(-Infinity)
				if (!earlier[id]) return Promise.resolve()
				if (asking) return asking.then(() => all && loadEarlier(id, true))
				const oldest = (entries[id] ?? []).find((entry) => !entry.sending)?.id
				if (oldest === undefined) return Promise.resolve()
				asking = (async () => {
					const found = await api(`/api/threads/${id}?before=${oldest}${all ? '' : '&last=50'}`)
					const nextOldest = all ? 0 : (found.entries[0]?.id ?? 0)
					if (socket?.readyState === socket.OPEN) {
						const waitTurns = new Promise((resolve) => (turnsDone = () => resolve(undefined)))
						socket.send(JSON.stringify({ earlier: id, before: nextOldest, all }))
						await waitTurns
					}
					hold()
					prependOlder(id, found.entries, all ? false : Boolean(found.earlier))
				})()
					.catch(report)
					.finally(() => {
						asking = null
					})
				return asking
			})
			setScrollMode({ kind: 'following' })
			setShownFrom(null)
			answerRoom = null
			padded = false
			if (room) room.style.height = '0px'
			markRead(id)
			const onVisible = () => markRead(id)
			document.addEventListener('visibilitychange', onVisible)
			const close = watch(
				(message) => {
					if (message.thread !== id) return
					if (message.older && message.done) finishTurns()
					if (message.activity) heardActivity(id, message.activity)
					if (message.agent && message.entries) {
						heard(message.agent, message.entries, {
							whole: !message.older && !heardFrom.has(message.agent),
							older: message.older,
							cut: message.cut,
						})
						if (!message.older) heardFrom.add(message.agent)
					}
					if (message.live)
						setDoing((work) => {
							work[id] ??= {}
							work[id][message.agent] ??= {}
							reconcile(message.live, 'callId')(work[id][message.agent])
						})
				},
				(opened) => {
					socket = opened
					heardFrom.clear()
					finishTurns()
					socket.send(JSON.stringify({ watch: id }))
				},
			)
			// Its messages stay, so coming back shows them at once while the feed catches up.
			return () => {
				releaseFeed()
				close()
				finishTurns()
				pagers.delete(id)
				document.removeEventListener('visibilitychange', onVisible)
				setDoing((work) => {
					delete work[id]
				})
			}
		},
	)
	// What you send keeps some of the view free under it, so the answer fills that without moving anything, and what came before stays in sight
	createEffect(
		() => messages().at(-1)?.sending,
		(mine) => {
			if (!mine || !list) return
			padded = false
			const row = [...list.querySelectorAll(':scope > li.mine')].at(-1) ?? null
			answerRoom = row ? { sent: row, reserve: null } : null
			startGlide()
		},
	)
	/** Following the bottom watches the list's real size: a row added or growing, an image loading, the list itself resized */
	const follow = (list) => {
		unfollow.set(list, () => {
			answerRoom = null
			setScrollMode({ kind: 'detached' })
		})
		const fill = () => {
			if (!answerRoom) return
			// Your message comes back from the server as a new row
			if (!answerRoom.sent.isConnected)
				answerRoom.sent = [...list.querySelectorAll(':scope > li.mine')].at(-1) ?? null
			if (!answerRoom.sent) {
				answerRoom = null
				return void (room.style.height = '0px')
			}
			const style = getComputedStyle(list)
			const top = Number.parseFloat(style.paddingTop)
			const seen = list.clientHeight - top - Number.parseFloat(style.paddingBottom)
			const offset = (element, edge) =>
				element.getBoundingClientRect()[edge] - list.getBoundingClientRect().top + list.scrollTop
			const end = offset(room, 'top')
			// Measured from the room by layout, so your message sliding in doesn't move what it's measured against
			const mine = end - (room.offsetTop - answerRoom.sent.offsetTop - answerRoom.sent.offsetHeight)
			// Space already left under your message, from an answer shorter than its room, is enough when it's a good part of the
			// view; otherwise enough that your message rises to the top with the answer's page under it
			if (answerRoom.reserve === null) {
				// Less what your message itself took, so the room gives that back and nothing moves
				const growth = Math.max(0, list.scrollHeight - (followed ?? list.scrollHeight))
				const left = end + room.offsetHeight - mine - growth
				answerRoom.reserve =
					left >= 0.4 * seen
						? left
						: Math.max(0.4 * seen, seen - answerRoom.sent.offsetHeight - 2 * top)
			}
			const under = answerRoom.reserve
			// A short thread already has the room, below the view's own end
			const short = mine + under <= top + seen
			const free = short ? 0 : Math.max(0, mine + under - end)
			room.style.height = `${free}px`
			if (free) return
			// The answer outgrew the room: the view stays where it is, and following picks up again once you scroll to the end
			answerRoom = null
			if (!short) setScrollMode({ kind: 'detached' })
		}
		/** The line you tap holds still: what opens grows downward, and what closes near the end leaves room under it until something new comes */
		list.addEventListener(
			'click',
			(event) => {
				const summary = event.target.closest?.('summary')
				if (!summary || !list.contains(summary)) return
				const details = summary.parentElement
				const was = details.open
				const next = { kind: 'holding', summary, top: summary.getBoundingClientRect().top }
				setScrollMode(next)
				const release = () =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => {
							if (scrollMode === next) settle()
						}),
					)
				// A line fills in once it hears its own toggle, so the hold lasts until that has been laid out
				details.addEventListener('toggle', release, { once: true })
				// A click that toggled nothing, like a link in the line, lets go at once
				requestAnimationFrame(() => {
					if (details.open === was) {
						details.removeEventListener('toggle', release)
						release()
					}
				})
			},
			true,
		)
		const keep = () => {
			if (!scrollMode.summary.isConnected) return settle()
			const shift = scrollMode.summary.getBoundingClientRect().top - scrollMode.top
			const short = list.scrollTop + shift + list.clientHeight - list.scrollHeight
			if (short > 0) {
				room.style.height = `${room.offsetHeight + short}px`
				padded = true
			}
			if (shift) list.scrollTop += shift
			followed = list.scrollHeight
		}
		/**
		 * The first row in view before an earlier page goes on top, and where its end sat; it stays there until that page is
		 * laid out. Its end, since its author's name goes once the row above it is theirs too.
		 */
		hold = () => {
			const edge = list.getBoundingClientRect().top
			const row = [...list.children].find((row) => row.getBoundingClientRect().bottom > edge)
			if (!row) return
			const next = { kind: 'anchoring', row, bottom: row.getBoundingClientRect().bottom }
			setScrollMode(next)
			requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					if (scrollMode === next) settle()
				}),
			)
		}
		startGlide = () => {
			setScrollMode({ kind: 'following' })
			fill()
			if (scrollMode.kind !== 'following') {
				followed = list.scrollHeight
				return
			}
			const target = list.scrollHeight
			const distance = target - list.clientHeight - list.scrollTop
			if (distance > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
				const done = () => {
					if (scrollMode.kind !== 'gliding' || scrollMode.done !== done) return
					const landedNearTarget = list.scrollTop + list.clientHeight >= target - 4
					const grown = list.scrollHeight > target
					if (landedNearTarget && grown) list.scrollTop = list.scrollHeight
					settle()
					followed = list.scrollHeight
				}
				const timer = setTimeout(done, 1000)
				list.addEventListener('scrollend', done, { once: true })
				setScrollMode({
					kind: 'gliding',
					done,
					cancel: () => {
						clearTimeout(timer)
						list.removeEventListener('scrollend', done)
					},
				})
				list.scrollTo({ top: target, behavior: 'smooth' })
			} else {
				list.scrollTop = target
			}
			followed = list.scrollHeight
		}
		bottom = () => {
			if (scrollMode.kind === 'anchoring') {
				if (!scrollMode.row.isConnected) {
					settle()
				} else {
					list.scrollTop += scrollMode.row.getBoundingClientRect().bottom - scrollMode.bottom
					followed = list.scrollHeight
					return nearTop()
				}
			}
			if (scrollMode.kind === 'holding') return keep()
			if (padded && !answerRoom) room.style.height = '0px'
			padded = false
			fill()
			if (scrollMode.kind === 'following') list.scrollTop = list.scrollHeight
			followed = list.scrollHeight
			nearTop()
		}
		sizes = new ResizeObserver(() => {
			const column = list.parentElement
			const height = (element) => {
				if (!element) return 0
				sizes.observe(element)
				if (!element.getClientRects().length) return 0
				const style = getComputedStyle(element)
				return (
					element.getBoundingClientRect().height +
					Number.parseFloat(style.marginTop) +
					Number.parseFloat(style.marginBottom)
				)
			}
			column.style.setProperty(
				'--thread-top',
				`${height(column.querySelector(':scope > header'))}px`,
			)
			column.style.setProperty(
				'--compose-height',
				`${height(column.querySelector(':scope > form.compose'))}px`,
			)
			bottom()
		})
		sizes.observe(list)
		changes = new MutationObserver((records) => {
			for (const change of records)
				for (const row of change.addedNodes) if (row.nodeType === 1) sizes.observe(row)
		})
		changes.observe(list, { childList: true })
	}
	return html`
		<article
			data-thread=${() => props.id}
			class=${() => [
				'thread',
				{
					current: current() === props.id,
					'hands-off': !!(props.id ? thread()?.tools : newThreadTools()),
				},
			]}
		>
			<header>
				<h2 class="title">
					<button
						type="button"
						class="ghost thread-name"
						title="Thread details and tools"
						aria-pressed=${() => String(sideOf(props.id)?.key === 'details')}
						style=${() => colorOf(homeBot(props.id)?.name ?? '')}
						onClick=${titleClick}
						onContextMenu=${(event) =>
							props.id &&
							nativeMenu(
								event,
								threadMenu(props.id, { archived: thread()?.archived, open: false }),
							)}
					>
						<span>${() => (props.id ? thread()?.title : 'a new thread')}</span>
						<${Dot} state=${() => thread()?.status} />
					</button>
				</h2>
				<${Show} when=${() => props.id && columns().length > 1}>
					<button
						type="button"
						class="close"
						title="Close here; the thread details still list it"
						aria-label="Close"
						onClick=${() => closeColumn(props.id)}
					>
						<${Icon} name="close" />
					</button>
				<//>
			</header>
			<${Show} when=${() => props.id}>
				<ul
					ref=${(el) => {
						list = el
						follow(el)
					}}
					onScroll=${() => {
						// Only a scroll at the height we last followed is the reader's; one from content moving under them keeps following
						if (
							list.scrollHeight === followed &&
							(scrollMode.kind === 'following' || scrollMode.kind === 'detached')
						)
							settle()
						nearTop()
					}}
					aria-label="Messages"
				>
					<${Show} when=${() => props.id && !ready()}
						><li class="mute asking">Asking for messages…</li><//
					>
					<${Show} when=${() => ready() && homeBot(props.id)?.instructions === ''}>
						<li class="mute">
							${() =>
								`${homeBot(props.id).name} has no instructions yet. ` +
								`Talk to ${homeBot(props.id).name} and find out who it is.`}
						</li>
					<//>
					<${For} each=${onScreen} keyed=${(row) => row.key}
						>${(row) => html`
							<${Show} when=${() => row().break}>
								<${Break} kind=${() => row().break} time=${() => row().time} />
							<//>
							<${Switch}
								fallback=${() => html`
									<${Message}
										time=${() => row().time}
										thread=${() => row().thread ?? props.id}
										entry=${() => row().entry}
										at=${() =>
											earlier[props.id] || row().thread
												? undefined
												: positions().get(row().entry.id)}
										row=${() => row()}
										waiting=${() => row().waiting}
									/>
								`}
							>
								<${Match} when=${() => row().cut}>
									<li class="cut mute">
										<button type="button" onClick=${() => setUnfolded((on) => !on)}>
											${() =>
												(unfolded() ? 'fold again: ' : 'unfold: ') +
												(row().memory
													? 'above here the agent reads the memory lines'
													: 'above here the agent reads a summary')}
										</button>
									</li>
								<//>
								<${Match} when=${() => row().line}>
									<li
										class="line"
										title=${() => `messages ${row().at} to ${row().at + row().n - 1}`}
									>
										<details>
											<summary
												onClick=${() => {
													if (row().text.includes('not summarized yet'))
														api(`/api/threads/${props.id}/memory?zoom=${row().at},${row().n}`).then(
															(opened) =>
																setOpenedGaps((all) => {
																	all[row().key] =
																		opened.message ??
																		opened.lines.map((line) => line.text).join('\n')
																}),
														)
												}}
											>
												<small>${() => firstLine(row().text)}</small>
											</summary>
											<div
												class="body markdown"
												innerHTML=${() => markdown(stripSummaryTag(openedGaps[row().key] ?? (row().text.includes('not summarized yet') ? 'Opening…' : row().text)), links)}
											/>
										</details>
									</li>
								<//>
								<${Match} when=${() => row().drew}>
									<${CanvasRow}
										step=${() => row().drew}
										agent=${() => row().agent}
										thread=${() => props.id}
									/>
								<//>
								<${Match} when=${() => row().voice === 'run'}>
									<${ScheduledRun} data=${() => row().entry.data} entry=${() => row().entry.id} />
								<//>
								<${Match} when=${() => row().scheduled}>
									<${ScheduledTaskSet} step=${() => row().scheduled} agent=${() => row().agent} />
								<//>
								<${Match} when=${() => row().changed}>
									<${Changed} step=${() => row().changed} agent=${() => row().agent} />
								<//>
								<${Match} when=${() => row().asked}>
									<${Asked} row=${() => row()} />
								<//>
								<${Match} when=${() => row().ask}>
									<${Exchange} thread=${() => props.id} row=${() => row()} />
								<//>
								<${Match} when=${() => row().turn || row().live}>
									<${Turn}
										thread=${() => props.id}
										agent=${() => row().agent}
										turn=${() => row().turn}
										live=${() => row().live}
										name=${() => row().name}
									/>
								<//>
							<//>
						`}<//
					>
					<li class="room" aria-hidden="true" ref=${(el) => (room = el)}></li>
				</ul>
			<//>
			<${Composer} thread=${() => props.id} />
		</article>
	`
}

/** A message's or run's author, above it, in their colour; with `to`, whom it answers */
export const Name = (props) => html`
	<small title=${() => props.author}
		><span style=${() => colorOf(props.author)}>${() => authorLabel(props.author)}</span
		><${Show} when=${() => props.to}
			>${' to '}<span style=${() => colorOf(props.to)}>${() => shortLabel(props.to)}</span><//
		></small
	>
`

/** One message as the thread's projection describes it: its `row` says whose voice, which name to show and to whom */
function Message(props) {
	const arriving = untrack(
		() => props.entry.sentAt != null && performance.now() - props.entry.sentAt < 1000,
	)
	const data = () => props.entry.data
	/** Its right-click menu in arbe desktop: the selection, else the whole message, quoted or copied, and its fork */
	const messageMenu = (element) => {
		const text = selectedIn(element) || data().body || ''
		// Into the composer on screen, the column's, as the Quote button does: a bot's home shows its side questions' answers too
		const column = Number(
			element.closest('article.thread[data-thread]')?.dataset.thread ?? props.thread,
		)
		return [
			text.trim() ? { label: 'Quote', run: () => appendQuote(column, text) } : null,
			text.trim() ? { label: 'Copy', run: () => copyText(text) } : null,
			null,
			props.entry.sending || props.waiting
				? null
				: { label: 'Fork from here', run: () => fork(props.thread, props.entry.id) },
		]
	}
	const row = () => props.row
	const crossed = () => ['sent', 'received'].includes(row().voice)
	return html`
		<li
			data-message=${() => props.at}
			data-entry=${() => props.entry.id}
			onContextMenu=${(event) =>
				// An image or a link keeps the webview's own menu: Copy image, Copy link
				event.target.closest('img, a[href]') || nativeMenu(event, messageMenu(event.currentTarget))}
			class=${() => ({
				sending: arriving,
				handed: litIn(props.thread, props.entry.id),
				elsewhere: crossed(),
				failed: row().failed,
				mine: row().voice === 'mine',
				same: row().voice === 'said' && !row().name,
			})}
		>
			<${Switch}
				fallback=${html`
					<${Show} when=${() => row().name}>
						<${Name} author=${() => row().name} to=${() => row().to} />
					<//>
					<${Show} when=${() => row().clamp} fallback=${html`<${Body} data=${() => data()} />`}>
						<${Clamp}><${Body} data=${() => data()} /><//>
					<//>
					<${Images} images=${() => data().images} />
				`}
			>
				<${Match} when=${crossed}>
					<ol class="steps">
						<${Cross} row=${() => row()} data=${() => data()} />
					</ol>
				<//>
				<${Match} when=${() => row().voice === 'stopped'}>
					<div class="links mute" title="Stop ended the thread's work">
						${() => `stopped by ${shortLabel(data().author)}`}
					</div>
				<//>
			<//>
			<${Show} when=${() => row().picked}>
				<div class="links" title="The director chose whom this asks">
					${() => (row().pickedNobody ? 'director picked nobody: ' : 'director picked ')}
					<${For} each=${() => data().to ?? []}
						>${(name) => html`<span style=${() => colorOf(name)}>${() => authorLabel(name)}</span>: `}<//
					>${() => row().picked}
				</div>
			<//>
			<${For} each=${() => row().forks ?? []}
				>${(fork) => html`
					<div class="links">
						<${ThreadLink} id=${() => fork.id}>${() => `forked → ${fork.title}`}<//>
					</div>
				`}<//
			>
			<${Show} when=${() => props.waiting}>
				<button
					class="ghost small fork withdraw"
					aria-label="Take back this message"
					title="Take it back: no agent has read it yet"
					onClick=${(_e) =>
						api(`/api/threads/${props.thread}/withdraw`, { entry: props.entry.id }).catch(report)}
				>
					<${Icon} name="close" />
				</button>
			<//>
			<div class="foot">
				<${Stamp} time=${() => props.time} />
				<${Show} when=${() => !props.entry.sending && !props.waiting}>
					<button
						class="ghost small fork"
						title="A new thread from this message"
						onClick=${() => fork(props.thread, props.entry.id).catch(report)}
					>
						fork
					</button>
				<//>
			</div>
		</li>
	`
}

/**
 * A long message folded to its first lines, fading out over a Show more; only when it really runs past them, measured as it
 * lays out. Each starts folded, and stays as you leave it while it's on screen.
 */
export function Clamp(props) {
	const [open, setOpen] = createSignal(false)
	const [long, setLong] = createSignal(false)
	let box, sizes, fold
	onSettled(() => {
		sizes = new ResizeObserver(() => {
			// Folded, the box is cut at its max height; open, it's measured against the height it had folded
			if (!open()) fold = box.clientHeight
			setLong(box.scrollHeight > fold + 1)
		})
		sizes.observe(box)
		return () => sizes.disconnect()
	})
	return html`
		<div class=${() => ({ clamp: true, open: open(), long: long() })} ref=${(el) => (box = el)}>
			${() => props.children}
		</div>
		<${Show} when=${long}>
			<button class="ghost small more" onClick=${() => setOpen((was) => !was)}>
				${() => (open() ? 'Show less' : 'Show more')}
			</button>
		<//>
	`
}

/**
 * A message that crossed threads, as a step of a run, on two lines: → sent or ← received, "new thread" when a post
 * started it, the other side as a link to its thread, the model it asked and, for a post, a ring while that thread works
 * or a ✓; under it, the message's first line, quieter, which a tap opens to the whole message in ink. Who and where come from its `row`; `sent` overrides its voice, as an
 * ask's answer comes back on the ask's own row.
 */
export function Cross(props) {
	const sent = () => props.sent ?? props.row.voice === 'sent'
	const label = () => props.row.otherLabel
	const working = () => !props.row.answer && threadOf(props.row.otherThread)?.status === 'working'
	return html`
		<li class=${() => ['call', sent() ? 'sent' : 'received']}>
			<details>
				<summary
					title=${() =>
						props.title ??
						`${sent() ? 'to' : 'from'} ${props.row.otherAuthor || label()} in thread ${props.row.otherThread}`}
				>
					<span class="tool"
						><${Show} when=${() => props.row.fresh && sent()}
							><span class="mute">new thread </span><//
						><${ThreadLink} id=${() => props.row.otherThread}
							><span
								style=${() => (props.row.otherModel ? undefined : colorOf(props.row.otherAuthor))}
								>${label}</span
							><//
						><${Show} when=${() => props.row.otherModel}
							><span class="mute">${() => ` ${props.row.otherModel}`}</span><//
						><${Show} when=${() => props.row.ask && sent()}
							><${Show}
								when=${working}
								fallback=${html`<span class="mark mute" aria-label="done"><${Icon} name="check" /></span>`}
								><span class="mark" aria-label="working"><${Dot} state="working" /></span><//><//
					></span>
					<span class="in">${() => (props.data.body ?? '').replace(/\s+/g, ' ')}</span>
				</summary>
				<div class="whole">
					<${Body} data=${() => props.data} />
					<${Images} images=${() => props.data.images} />
				</div>
			</details>
		</li>
	`
}

/** A question another thread asked here, as a received row at the moment it came; its answer follows as the bot's own message */
const Asked = (props) => html`
	<li class="elsewhere">
		<ol class="steps">
			<${Cross}
				row=${() => props.row}
				data=${() => props.row.question.data}
				title=${() => `${props.row.otherAuthor} asked in thread ${props.row.otherThread}`}
			/>
		</ol>
	</li>
`

/** A thread a message mentions by title, archived ones too; the newest of that title */
const byTitle = createRoot(() =>
	createMemo(() => {
		const titled = new Map()
		const { open, archived } = threadRows()
		for (const row of [...open, ...archived]) if (!titled.has(row.title)) titled.set(row.title, row)
		return titled
	}),
)
const threadLink = (title) => {
	const thread = byTitle().get(title)
	return thread && { href: hrefOf(thread.id), id: thread.id, title }
}

/** A bot a message @mentions, in its colour; mentions match names ignoring case, as `mentioned` does */
const botColor = (name) => {
	const bot = bots.find((bot) => bot.name.toLowerCase() === name.toLowerCase())
	return bot ? colorOf(bot.name) : ''
}

/** What message markdown links: threads by title, bots by name */
export const links = { threadLink, botColor }

/** Each thread's list → what stops it following its bottom */
const unfollow = new WeakMap()
/** Scrolls a message's row into the middle of its thread and lights it a moment, as a recap link or search result does;
 * the thread stops following its bottom, so rows still landing don't take it away */
export function reveal(row, behavior = /** @type {ScrollBehavior} */ ('smooth')) {
	unfollow.get(row.parentElement)?.()
	row.scrollIntoView({ block: 'center', behavior })
	row.classList.add('handed')
	setTimeout(() => row.classList.remove('handed'), 1500)
}

/** What a message says: markdown, except a `$ cmd` and an error, which stay as written. A thread it mentions opens here. */
export const Body = (props) => html`
	<${Show}
		when=${() => !props.data.shell && !props.data.error}
		fallback=${html`<span class="body">${() => props.data.body}</span>`}
	>
		<${MessageMarkdown} text=${() => props.data.body}
	/><//>
`

export function MessageMarkdown(props) {
	const markup = createMemo(() => {
		const text = props.text ?? ''
		const mermaid = server().modules.includes('mermaid')
		if (props.live && !(mermaid && /(?:`{3,}|~{3,})mermaid\b/i.test(text))) return null
		const markup = markdown(text, { ...links, mermaid })
		return props.live && !markup.includes('<pre data-mermaid>') ? null : markup
	})
	return html`<${Show} when=${() => markup() !== null} fallback=${() => props.text}>
		${() => {
			let draw
			createEffect(markup, (markup) => draw?.(markup))
			return html`<div
				class="body markdown"
				ref=${(element) => (draw = messageDiagrams(element))}
				onClick=${(event) => {
					const link = event.target.closest('a[data-thread]')
					if (link) followThread(event, Number(link.dataset.thread))
				}}
			/>`
		}}<//
	> `
}

const Images = (props) => html`
	<${Show} when=${() => props.images?.length}>
		<div class="images">
			<${For} each=${() => props.images}
				>${(image) => {
					// Data URLs display inline, but browsers block opening them as pages.
					const url = createMemo(() => {
						const bytes = Uint8Array.from(atob(image.data), (char) => char.charCodeAt(0))
						return URL.createObjectURL(new Blob([bytes], { type: image.mimeType }))
					})
					createEffect(url, (url) => () => URL.revokeObjectURL(url))
					// A plain click shows it over the page; a modified one still opens a tab.
					const [shown, setShown] = createSignal(false)
					let dialog
					const open = (event) => {
						if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
							return
						event.preventDefault()
						setShown(true)
						dialog.showModal()
					}
					return html`<a
							href=${() => url()}
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Open image full size"
							onClick=${open}
						>
							<img src=${() => imageUrl(image)} alt="" loading="lazy" />
						</a>
						<dialog
							class="lightbox"
							closedby="any"
							aria-label="Image"
							ref=${(element) => (dialog = element)}
							onClick=${() => dialog.close()}
							onClose=${() => setShown(false)}
						>
							<${Show} when=${shown}><img src=${() => url()} alt="" /><//>
						</dialog>`
				}}<//
			>
		</div>
	<//>
`

const ThreadLink = (props) => html`
	<a
		class="thread-link"
		href=${() => hrefOf(props.id)}
		onClick=${(event) => followThread(event, props.id)}
		>${() => props.children}</a
	>
`
