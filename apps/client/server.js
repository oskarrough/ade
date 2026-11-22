/** The server, as this client sees it: one versioned feed over /ws, one store in memory */
import {
	action,
	createEffect,
	createMemo,
	createOptimisticStore,
	createRoot,
	createSignal,
	createStore,
	latest,
	onSettled,
	snapshot,
	untrack,
} from 'solid-js'

export const params = new URLSearchParams(location.search)
/** Just the chat, or the live system around it */
export const [chat, setChat] = createSignal(!params.has('story'))

/** What a fresh page shows before the server has answered once */
const DEFAULT_SERVER = {
	modules: [],
	off: [],
	about: {},
	settings: {
		overrides: [],
		director: {},
		memory: { model: '', compactAt: null },
	},
}
export const url = params.get('server') || location.origin
/** A link with the owner's key after `#key=` brings this browser in: the server keeps it as a cookie, and the address drops it */
const ownerKey = new URLSearchParams(location.hash.slice(1)).get('key')
if (ownerKey) {
	history.replaceState(null, '', location.pathname + location.search)
	await fetch(`${url}/api/me`, {
		method: 'POST',
		headers: { authorization: `Bearer ${ownerKey}` },
	}).catch(() => {})
}
export const api = (path, body, method = body === undefined ? 'GET' : 'POST') =>
	fetch(url + path, {
		headers: { 'Content-Type': 'application/json' },
		method,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
		.catch((error) => {
			throw error instanceof TypeError ? new Error("Can't reach the server") : error
		})
		.then(async (response) => {
			const json = await response.json()
			if (!response.ok) throw new Error(json.error)
			return json
		})

/** A socket belongs to its caller; disposing it also cancels a pending reconnect. */
export function watch(receive, opened = (_socket) => {}, closed = () => {}) {
	let socket, timer
	const connect = () => {
		socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`)
		socket.onopen = () => opened(socket)
		socket.onmessage = (event) => receive(JSON.parse(event.data))
		socket.onclose = () => {
			closed()
			timer = setTimeout(connect, 1000)
		}
	}
	connect()
	return () => {
		clearTimeout(timer)
		socket.onclose = socket.onmessage = socket.onopen = null
		socket.close()
	}
}

/** Page lifetime; components own the messages of just the threads on screen. */
const [connected, setConnected] = createSignal(false)
export { connected }
export const [newThreadTools, setNewThreadTools] = createSignal(null)
/** The last key this page made, {name, connect}: the key is shown once, so it outlives the form that asked */
export const [minted, setMinted] = createSignal(null)
/** Each thread's messages, written only by the `thread/<id>` feed, older pages and optimistic sends. */
const [entries, setEntries] = createStore({}, { shallow: true })
/** Whether a thread has messages before the ones on screen, which come a page at a time as you scroll up */
const [earlier, setEarlier] = createStore({})
const [people, setPeople] = createStore({})
export { entries, earlier, people }
let heardNewDraft = (_message) => {}
/** The composer hears your new-thread draft change on another page of yours through this */
export const onNewDraft = (hear) => void (heardNewDraft = hear)
/** Each watched thread's way to ask for its page before the ones it has, or all of them; answers once they're in */
export const pagers = new Map()
export const loadEarlier = (thread, all = false) =>
	earlier[thread] || all ? (pagers.get(thread)?.(all) ?? Promise.resolve()) : Promise.resolve()
/** Earlier pages loaded by scrolling up, per thread, and optimistic sends keyed by request `key` */
const olderPages = new Map()
const pendingSent = new Map()
const sentAtByKey = new Map()
const feedEntries = new Map()
function recomputeEntries(thread) {
	const live = feedEntries.get(thread)
	const older = olderPages.get(thread) ?? []
	const pending = pendingSent.get(thread) ?? []
	if (!live && !older.length && !pending.length) return
	const serverList = live ?? []
	const haveIds = new Set(serverList.map((entry) => entry.id))
	const haveKeys = new Set(serverList.map((entry) => entry.data?.key).filter(Boolean))
	const stamped = serverList.map((entry) => {
		const at = entry.data?.key && sentAtByKey.get(entry.data.key)
		return at !== undefined && entry.sentAt === undefined ? { ...entry, sentAt: at } : entry
	})
	const waiting = pending.filter((entry) => !haveKeys.has(entry.data.key))
	if (waiting.length !== pending.length) {
		if (waiting.length) pendingSent.set(thread, waiting)
		else pendingSent.delete(thread)
	}
	setEntries((all) => {
		all[thread] = [...older.filter((entry) => !haveIds.has(entry.id)), ...stamped, ...waiting]
	})
}
/** Prepends an earlier page loaded on scroll; `more` updates `earlier[thread]` */
export function prependOlder(thread, more, hasEarlier) {
	const currentOlder = olderPages.get(thread) ?? []
	const have = new Set(currentOlder.map((entry) => entry.id))
	olderPages.set(thread, [...more.filter((entry) => !have.has(entry.id)), ...currentOlder])
	setEarlier((all) => {
		all[thread] = hasEarlier
	})
	recomputeEntries(thread)
}
/** Your message shows the moment you send it, marked `sending`, matched to the server's copy by its request `key` */
export function sending(thread, data) {
	const at = performance.now()
	if (data.key) sentAtByKey.set(data.key, at)
	const entry = {
		id: (entries[thread]?.at(-1)?.id ?? 0) + 0.9,
		sending: true,
		sentAt: at,
		speaker: me(),
		showName: false,
		voice: 'mine',
		clamp: true,
		failed: false,
		data: { author: me(), ...data },
	}
	pendingSent.set(thread, [...(pendingSent.get(thread) ?? []), entry])
	recomputeEntries(thread)
	const drop = () => {
		const list = pendingSent.get(thread)
		if (!list?.includes(entry)) return
		const next = list.filter((one) => one !== entry)
		if (next.length) pendingSent.set(thread, next)
		else pendingSent.delete(thread)
		recomputeEntries(thread)
	}
	const settle = (seq, boot) => {
		if (typeof seq === 'number') void caughtUp(`thread/${thread}`, seq, boot).then(drop)
		else drop()
	}
	return { drop, settle }
}
const [current, setCurrent] = createSignal(Number(params.get('thread')) || null)
export { current }

/** Whether the inbox takes the threads' place; opening a thread leaves it */
const [inboxOpen, setInboxOpen] = createSignal(params.has('inbox'))
export { inboxOpen }
export function openInbox() {
	setInboxOpen(true)
	setSearchFor(null)
	setUsageOpen(false)
	drawer(null)
	const next = new URL(location.href)
	next.searchParams.delete('search')
	next.searchParams.delete('usage')
	next.searchParams.set('inbox', '')
	history.replaceState(null, '', next)
}

/** What search results in the threads' place are for, or null while they're closed; opening a thread or the inbox closes them */
const [searchFor, setSearchFor] = createSignal(params.get('search') || null)
export { searchFor }
export function openSearch(text) {
	setInboxOpen(false)
	setUsageOpen(false)
	setSearchFor(text)
	const next = new URL(location.href)
	next.searchParams.delete('inbox')
	next.searchParams.delete('usage')
	next.searchParams.set('search', text)
	history.replaceState(null, '', next)
}

/** Whether the house's usage takes the threads' place; opening a thread, the inbox or search leaves it */
const [usageOpen, setUsageOpen] = createSignal(params.has('usage'))
export { usageOpen }
export function openUsage() {
	setUsageOpen(true)
	setInboxOpen(false)
	setSearchFor(null)
	drawer(null)
	const next = new URL(location.href)
	next.searchParams.delete('inbox')
	next.searchParams.delete('search')
	next.searchParams.set('usage', '')
	history.replaceState(null, '', next)
}

export function openThread(id) {
	// Moving into a column on screen keeps every column where it is; going anywhere else leaves those opened beside
	const shown = untrack(columns)
	setBeside(shown.includes(id) && shown.length > 1 ? shown : [])
	setInboxOpen(false)
	setSearchFor(null)
	setUsageOpen(false)
	setCurrent(id)
	drawer(null)
	history.replaceState(null, '', hrefOf(id))
}

/** A link to a thread opens it here, and still opens in a new tab or window when the click asks for one */
/** Ctrl-click, or Cmd-click on a Mac, opens a thread in a column beside the ones on screen */
export const besideKey = (event) => Boolean(event?.ctrlKey || event?.metaKey)

/** A thread link's click: a plain one opens the thread, Ctrl or Cmd puts it beside, Shift and Alt are the browser's */
export function followThread(event, id) {
	if (event.shiftKey || event.altKey) return
	event.preventDefault()
	if (besideKey(event)) openBeside(id)
	else openThread(id)
}

/** A thread's address: what a real link needs, so it can also be opened in a new tab or copied */
export function hrefOf(id) {
	const next = new URL(location.href)
	next.searchParams.delete('inbox')
	next.searchParams.delete('search')
	if (id) next.searchParams.set('thread', id)
	else next.searchParams.delete('thread')
	return next.pathname + next.search
}

export function drawer(which) {
	document.body.classList.toggle(
		'list',
		which === 'list' && !document.body.classList.contains('list'),
	)
}

export const {
	threads,
	archivedThreads,
	threadRows,
	runners,
	server,
	behind,
	changes,
	bots,
	inbox,
	dismiss,
	threadOf,
	familyOf,
	family,
	columns,
	closeColumn,
	openBeside,
	setBeside,
	archiveThread,
	renameThread,
	forgetBot,
	revokeRunner,
	subscribeView,
	viewStore,
	caughtUp,
	write,
} = createRoot(() => {
	// ── One versioned feed, one in-memory store ──
	let socket = null
	const sendSocket = (frame) => {
		if (socket?.readyState === 1) socket.send(JSON.stringify(frame))
	}
	/** Active views on this page, keyed by view name: `{ seq, synced, map, rows, setRows, waiters, refs, sort }` */
	const views = new Map()
	const orderOf = (view) => {
		const list = [...view.map.values()]
		return view.sort ? list.sort(view.sort) : list
	}
	const wakeWaiters = (view, force = false) => {
		if (!view.waiters.length) return
		view.waiters = view.waiters.filter((waiter) => {
			if (
				!force &&
				!(waiter.boot && view.boot && waiter.boot !== view.boot) &&
				(!view.synced || (view.seq ?? -1) < waiter.seq)
			)
				return true
			waiter.resolve()
			return false
		})
	}
	const applyFrame = (frame) => {
		const view = views.get(frame.view)
		if (!view) return
		const reset = Boolean(frame.reset || (view.boot && frame.boot && frame.boot !== view.boot))
		let changed = false
		if (reset) {
			view.map = new Map((frame.put ?? []).map((item) => [item.key, item.row]))
			view.boot = frame.boot ?? null
			view.seq = frame.seq
			view.synced = true
			changed = true
		} else {
			if (frame.boot) view.boot = frame.boot
			if (view.seq !== null && frame.seq < view.seq) return
			if (view.seq === null || frame.seq > view.seq) {
				for (const item of frame.put ?? []) {
					view.map.set(item.key, item.row)
					changed = true
				}
				for (const key of frame.del ?? []) {
					if (view.map.delete(key)) changed = true
				}
				view.seq = frame.seq
			}
			view.synced = true
		}
		if (changed) {
			view.setRows(orderOf(view))
			if (frame.view.startsWith('thread/')) {
				const threadId = Number(frame.view.slice('thread/'.length))
				// A reset starts a fresh server window (restart or idle eviction): drop older pages so the middle isn't missing
				if (reset) olderPages.delete(threadId)
				const meta = view.map.get('thread')
				if (meta) {
					if (meta.people)
						setPeople((all) => {
							all[threadId] = meta.people
						})
					if ('earlier' in meta && (reset || !olderPages.has(threadId)))
						setEarlier((all) => {
							all[threadId] = meta.earlier
						})
				}
				const msgs = [...view.map.entries()]
					.filter(([key]) => typeof key === 'number')
					.map(([, row]) => row)
					.sort((left, right) => left.id - right.id)
				feedEntries.set(threadId, msgs)
				recomputeEntries(threadId)
			}
		}
		wakeWaiters(view, reset)
	}
	const subscribeView = (name, { sort } = {}) => {
		let view = views.get(name)
		if (!view) {
			const [rows, setRows] = createSignal(/** @type {any[]} */ ([]))
			view = {
				name,
				boot: null,
				seq: null,
				synced: false,
				map: new Map(),
				rows,
				setRows,
				waiters: [],
				refs: 0,
				sort,
			}
			views.set(name, view)
		} else if (sort && !view.sort) {
			view.sort = sort
		}
		if (view.refs++ === 0) sendSocket({ sub: name })
		return {
			rows: view.rows,
			release: () => {
				if (--view.refs > 0) return
				views.delete(name)
				wakeWaiters(view, true)
				sendSocket({ unsub: name })
			},
		}
	}
	const viewStore = (name, key, options) => {
		const { rows } = subscribeView(name, options)
		return createOptimisticStore(() => rows(), /** @type {any[]} */ ([]), { key })
	}
	const caughtUp = (name, seq, boot = undefined) => {
		const view = views.get(name)
		if (!view) return Promise.resolve()
		if (boot && view.boot && view.boot !== boot) return Promise.resolve()
		if (view.synced && (view.seq ?? -1) >= seq) return Promise.resolve()
		sendSocket({ sync: name, seq })
		return new Promise((resolve) => view.waiters.push({ seq, boot, resolve }))
	}
	/** Writes that failed to reach the server, resent on socket reconnect with the same `key` */
	const inflight = new Map()
	const write = async (path, body, method = 'POST') => {
		const key = crypto.randomUUID()
		const target =
			body === undefined
				? `${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`
				: path
		const payload = body === undefined ? undefined : { ...body, key }
		const attempt = () => api(target, payload, method)
		try {
			return await attempt()
		} catch (error) {
			if (error.message !== "Can't reach the server") throw error
			return new Promise((resolve, reject) => {
				inflight.set(key, () => {
					inflight.delete(key)
					attempt().then(resolve, reject)
				})
			})
		}
	}

	const serverSub = subscribeView('server')
	/** The `client` and `commit` of the first answer this page got: what it was loaded with */
	let loadedWith, loadedAt
	const server = createMemo(() => {
		const data = serverSub.rows()[0]
		if (!data) return DEFAULT_SERVER
		loadedWith ??= data.client
		loadedAt ??= data.commit
		return data
	})
	/** Whether a reload would bring newer client files or a server that changed since this page loaded */
	const behind = createMemo(() => {
		const now = server().client
		return Boolean(loadedWith && now && now !== loadedWith)
	})
	/** The subjects of the commits since the one this page loaded on, newest first; none when the server isn't a checkout */
	const [changes, setChanges] = createSignal([])
	createEffect(
		() => behind() && server().commit,
		(commit) => {
			if (!commit || !loadedAt || commit === loadedAt) {
				setChanges([])
				return
			}
			api(`/api/changes?since=${loadedAt}`).then(
				({ commits }) => setChanges(commits),
				() => setChanges([]),
			)
		},
	)
	/** An inbox row is what it is in its thread: a thread's answer that becomes a question is a new row, not the same one changed */
	const inboxKey = (item) => `${item.kind} ${item.thread}`
	const inboxRank = { question: 0, failed: 1, answered: 2 }
	const inboxTime = (item) => (item.question ?? item.message).data.createdAt ?? ''
	const inboxSort = (left, right) =>
		inboxRank[left.kind] - inboxRank[right.kind] ||
		(inboxTime(left) < inboxTime(right) ? 1 : inboxTime(left) > inboxTime(right) ? -1 : 0)
	const byNewest = (left, right) => right.id - left.id
	const openSub = subscribeView('threads', { sort: byNewest })
	const archivedSub = subscribeView('archived', { sort: byNewest })
	const [threads, setOptimisticThreads] = createOptimisticStore(
		() => openSub.rows(),
		/** @type {any[]} */ ([]),
		{ key: 'id' },
	)
	const [archivedThreads, setOptimisticArchived] = createOptimisticStore(
		() => archivedSub.rows(),
		/** @type {any[]} */ ([]),
		{ key: 'id' },
	)
	/** Both lists as plain rows: a scan of the whole list reads this memo instead of every row's fields */
	const threadRows = createMemo(
		/** @returns {any} */ () => ({ open: openSub.rows(), archived: archivedSub.rows() }),
	)
	const [runners, setOptimisticRunners] = viewStore('runners', 'name')
	const [bots, setOptimisticBots] = viewStore('bots', 'name')
	/** What needs you, one entry per thread: open questions, then failures, then unread answers */
	const [inbox, setOptimisticInbox] = viewStore('inbox', inboxKey, { sort: inboxSort })
	/** A question is hidden for everyone until its thread asks again; a failure or an answer is marked read, for you */
	const dismiss = action(function* (item) {
		const key = inboxKey(item)
		setOptimisticInbox((rows) => rows.filter((row) => inboxKey(row) !== key))
		const { seq, boot } = yield item.question
			? write(`/api/threads/${item.thread}/inbox`, { dismiss: item.question.id })
			: write(`/api/threads/${item.thread}/read`, {})
		yield caughtUp('inbox', seq, boot)
	})
	/** The row moves the moment you ask; if the server refuses, it moves back and this throws why */
	const archiveThread = action(function* (id, archived) {
		if (archived && family().includes(id)) openThread(null)
		const moving = (archived ? threads : archivedThreads).find((row) => row.id === id)
		const moved = moving ? { ...snapshot(moving), archived } : null
		if (archived) {
			setOptimisticThreads((rows) => rows.filter((row) => row.id !== id))
			if (moved) setOptimisticArchived((rows) => [moved, ...rows].sort(byNewest))
		} else {
			setOptimisticArchived((rows) => rows.filter((row) => row.id !== id))
			if (moved) setOptimisticThreads((rows) => [moved, ...rows].sort(byNewest))
		}
		const { seq, boot } = yield write(`/api/threads/${id}/archive`, { archived })
		yield Promise.all([caughtUp('threads', seq, boot), caughtUp('archived', seq, boot)])
	})
	const renameThread = action(function* (id, title) {
		const patch = (rows) => rows.map((row) => (row.id === id ? { ...row, title } : row))
		setOptimisticThreads(patch)
		setOptimisticArchived(patch)
		const { seq, boot } = yield write(`/api/threads/${id}/title`, { title })
		yield Promise.all([caughtUp('threads', seq, boot), caughtUp('archived', seq, boot)])
	})
	const forgetBot = action(function* (name) {
		setOptimisticBots((rows) => rows.filter((row) => row.name !== name))
		const { seq, boot } = yield write(`/api/bots/${encodeURIComponent(name)}`, undefined, 'DELETE')
		yield caughtUp('bots', seq, boot)
	})
	const revokeRunner = action(function* (name) {
		setOptimisticRunners((rows) => rows.filter((row) => row.name !== name))
		const { seq, boot } = yield write(
			`/api/runners/${encodeURIComponent(name)}`,
			undefined,
			'DELETE',
		)
		yield caughtUp('runners', seq, boot)
	})
	/** Your new-thread draft comes too, as another page of yours changes it, which the composer takes */
	const receive = (message) => {
		if (message.view) return applyFrame(message)
		if (message.thread === 'new') heardNewDraft(message)
	}
	onSettled(() => {
		watch(
			receive,
			(ws) => {
				socket = ws
				setConnected(true)
				for (const [name, view] of views) {
					view.synced = false
					sendSocket({
						sub: name,
						...(view.seq !== null && view.boot ? { after: view.seq, boot: view.boot } : {}),
					})
				}
				for (const resend of inflight.values()) resend()
			},
			() => {
				socket = null
				setConnected(false)
				for (const view of views.values()) view.synced = false
			},
		)
	})
	/** Threads by id, rebuilt only when the feed updates or optimistic membership changes */
	const byId = createMemo(() => {
		threadRows()
		void threads.length
		return untrack(() => new Map(threads.map((thread) => [thread.id, thread])))
	})
	const threadOf = (id) => byId().get(id)
	/** A thread's family, from its root's server-computed `family` list */
	const familyOf = (id) => {
		const row = threadOf(id)
		return (row?.root ? threadOf(row.root)?.family : row?.family) ?? (row ? [{ id, depth: 0 }] : [])
	}
	/** The open thread's family ids: one thread until the list has it, `[null]` for a new one */
	const family = createMemo(() =>
		current()
			? ((list) => (list.length ? list.map((member) => member.id) : [current()]))(
					familyOf(current()),
				)
			: [null],
	)
	/** Family members you opened in this page; closing forgets one */
	const [open, setOpen] = createSignal(new Set())
	/** Other threads opened beside them with Ctrl or Cmd, in the order you opened them */
	const [beside, setBeside] = createSignal([])
	/** One more column, beside the ones on screen; the thread you're in stays */
	const openBeside = (id) => {
		if (!untrack(current)) return openThread(id)
		// From the inbox, search or usage, back to the threads, with this one beside
		if (untrack(inboxOpen) || untrack(searchFor) !== null || untrack(usageOpen))
			openThread(untrack(current))
		if (untrack(family).includes(id)) setOpen((ids) => new Set([...ids, id]))
		else setBeside((ids) => (ids.includes(id) ? ids : [...ids, id]))
	}
	createEffect(current, (here) => {
		if (here) setOpen((ids) => (ids.has(here) ? ids : new Set([...ids, here])))
	})
	/** The columns on screen: the thread you're in and the open members of its family, in the family's order */
	const columns = createMemo(() => {
		const shown = family().filter((id) => id === current() || open().has(id))
		const at = beside().indexOf(current())
		const before =
			at < 0
				? []
				: beside()
						.slice(0, at)
						.filter((id) => !shown.includes(id))
		const after = beside().filter((id) => !shown.includes(id) && !before.includes(id))
		return [...before, ...shown, ...after]
	})
	/** Closing the thread you're in moves you to its nearest open neighbour, or to a new thread when it was alone */
	const closeColumn = (id) => {
		if (id === current()) {
			const shown = columns()
			const at = shown.indexOf(id)
			openThread(shown[at + 1] ?? shown[at - 1] ?? null)
		}
		setOpen((ids) => {
			const next = new Set(ids)
			next.delete(id)
			return next
		})
		setBeside((ids) => ids.filter((each) => each !== id))
	}
	return {
		threads,
		archivedThreads,
		runners,
		server,
		behind,
		changes,
		bots,
		inbox,
		dismiss,
		threadOf,
		familyOf,
		threadRows,
		family,
		columns,
		closeColumn,
		openBeside,
		setBeside,
		archiveThread,
		renameThread,
		forgetBot,
		revokeRunner,
		subscribeView,
		viewStore,
		caughtUp,
		write,
	}
})

/** Subscribe to a dynamic view while `nameOf()` returns a view name; releases when it changes or disposes */
export function feedView(nameOf, options) {
	const [active, setActive] = createSignal(/** @type {any} */ (null))
	createEffect(nameOf, (name) => {
		if (!name) {
			setActive(null)
			return
		}
		const sub = subscribeView(name, options)
		setActive(sub)
		return () => sub.release()
	})
	return createMemo(() => active()?.rows() ?? [])
}
/** Subscribe to a thread's `thread/<id>` feed (shaped messages, people and earlier flag) */
export function openThreadFeed(id) {
	const sub = subscribeView(`thread/${id}`)
	return () => sub.release()
}
/** Subscribe to a single-row dynamic view (`recap/<id>`, `memory/<id>`, `usage/<id>`, `usage`) */
export function feedItem(nameOf) {
	const rows = feedView(nameOf)
	return createMemo(() => rows()[0] ?? null)
}

/** `first`, its first message, `{body, to, images, steer, key}`, comes in the same step; under the new-thread draft's key, it empties that draft */
export async function createThread(title, first = {}) {
	const tools = newThreadTools()
	const { id } = await api('/api/threads', { title, tools, ...first })
	if (latest(newThreadTools) === tools) setNewThreadTools(null)
	if (!latest(current)) openThread(id)
	return id
}
/** Changes a bot; the feed updates the row */
export const saveBot = (name, change) => write('/api/bots', { name, ...change })

export const fork = async (id, at) => openThread((await api(`/api/threads/${id}/fork`, { at })).id)

export const homeBot = (id) => bots.find((bot) => bot.home === id)
export const botAgent = (bot) => ({ ...bot.to, name: bot.name })
export const hues = Array.from(
	{ length: 8 },
	(_, index) => Math.round(50 + index * 137.508) % 360,
).sort((a, b) => a - b)
export const paint = (hue) => `light-dark(oklch(0.56 0.15 ${hue}), oklch(0.74 0.13 ${hue}))`
/** A bot's colour, as a style for `property`: the server sends the effective hue; anyone else has none */
export const hueOf = (name) => bots.find((bot) => bot.name === name)?.color
export const colorOf = (name, property = 'color') => {
	const hue = hueOf(name)
	return hue === undefined ? '' : `${property}: ${paint(hue)}`
}
export function forkedFrom(thread) {
	return thread?.conversation?.parent?.conversationId
}
export const titleOf = (id) => threadOf(id)?.title ?? `thread ${id}`

/** Who the server takes this page for, to show which messages are yours; the server decides who writes, not this */
export const me = () => server().me ?? ''
