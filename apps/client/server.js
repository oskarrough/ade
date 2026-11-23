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

/** The page's one socket, open again a second after it closes */
function connect(receive, opened, closed) {
	const socket = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`)
	socket.onopen = () => opened(socket)
	socket.onmessage = (event) => receive(JSON.parse(event.data))
	socket.onclose = () => {
		closed()
		setTimeout(() => connect(receive, opened, closed), 1000)
	}
}

/** Page lifetime; components own the messages of just the threads on screen. */
const [connected, setConnected] = createSignal(false)
export { connected }
/** '' until this page asks the server to restart; 'asked', then 'down' once the socket drops, and the page reloads when
 * it's back; 'stopped' where the server can't restart itself */
const [restarting, setRestarting] = createSignal('')
export { restarting }
/** Restarts the server, saving Settings' changes first when there are any, and reloads the page once it's back */
export const restart = async (settings) => {
	const { restarts } = await api(settings ? '/api/settings' : '/api/restart', settings ?? {})
	setRestarting(restarts ? 'asked' : 'stopped')
}
export const [newThreadTools, setNewThreadTools] = createSignal(null)
/** The last key this page made, {name, connect}: the key is shown once, so it outlives the form that asked */
export const [minted, setMinted] = createSignal(null)
/** Each thread's messages, written only by the `thread/<id>` feed, older pages and optimistic sends. */
const [entries, setEntries] = createStore({}, { shallow: true })
/** Whether a thread has messages before the ones on screen, which come a page at a time as you scroll up */
const [earlier, setEarlier] = createStore({})
const [people, setPeople] = createStore({})
export { entries, earlier, people }
/** Each watched thread's way to ask for its page before the ones it has, or all of them; answers once they're in */
export const pagers = new Map()
export const loadEarlier = (thread, all = false) =>
	earlier[thread] || all ? (pagers.get(thread)?.(all) ?? Promise.resolve()) : Promise.resolve()
/** A thread's messages come from three places, per thread: the feed's window, pages before it loaded by scrolling up, and
 * your sends still on their way, matched to the server's copy by their request `key` */
const feedEntries = new Map()
const olderPages = new Map()
const pendingSent = new Map()
/** When each of your sends left, by `key`, so its row keeps its identity once the server's copy replaces it */
const sentAtByKey = new Map()
function recomputeEntries(thread) {
	const live = feedEntries.get(thread)
	const older = olderPages.get(thread) ?? []
	const pending = pendingSent.get(thread) ?? []
	if (!live && !older.length && !pending.length) return
	const serverList = live ?? []
	const haveIds = new Set(serverList.map((entry) => entry.id))
	const haveKeys = new Set(serverList.map((entry) => entry.data?.key).filter(Boolean))
	const stamped = serverList.map((entry) => {
		const at = entry.data?.key ? sentAtByKey.get(entry.data.key) : undefined
		return at === undefined ? entry : { ...entry, sentAt: at }
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
/** A `thread/<id>` frame landed: its people and `earlier` flag, and its messages under the older pages and your sends */
function heardThread(thread, rows, reset) {
	// A reset starts a fresh server window (restart or idle eviction): drop older pages so the middle isn't missing
	if (reset) olderPages.delete(thread)
	const meta = rows.get('thread')
	if (meta?.people)
		setPeople((all) => {
			all[thread] = meta.people
		})
	if (meta && 'earlier' in meta && (reset || !olderPages.has(thread)))
		setEarlier((all) => {
			all[thread] = meta.earlier
		})
	feedEntries.set(
		thread,
		[...rows.entries()]
			.filter(([key]) => typeof key === 'number')
			.map(([, row]) => row)
			.sort((left, right) => left.id - right.id),
	)
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

/** What takes the threads' place: threads, inbox, usage, or search results. */
const PAGE_PARAMS = ['inbox', 'search', 'usage']
const initialPage = () => {
	if (params.has('inbox')) return { kind: 'inbox' }
	if (params.get('search')) return { kind: 'search', query: params.get('search') }
	if (params.has('usage')) return { kind: 'usage' }
	return { kind: 'threads' }
}
const [page, setPage] = createSignal(initialPage())
export { page }

function showPage(next, { closeDrawer = true } = {}) {
	setPage(next)
	if (closeDrawer) drawer(null)
	const address = new URL(location.href)
	for (const key of PAGE_PARAMS) address.searchParams.delete(key)
	if (next.kind === 'search') address.searchParams.set('search', next.query)
	else if (next.kind !== 'threads') address.searchParams.set(next.kind, '')
	history.replaceState(history.state, '', address)
}

export const openInbox = () => showPage({ kind: 'inbox' })
export const openSearch = (query) => showPage({ kind: 'search', query }, { closeDrawer: false })
export const openUsage = () => showPage({ kind: 'usage' })

export function openThread(id) {
	// Moving into a column on screen keeps every column where it is; going anywhere else leaves those opened beside
	const shown = untrack(columns)
	setBeside(shown.includes(id) && shown.length > 1 ? shown : [])
	setPage({ kind: 'threads' })
	setCurrent(id)
	// Picked from the phone's list, the thread is a page of its own on top of it, so back (the edge swipe, Android's back) returns to the list
	if (document.body.classList.contains('list')) {
		history.replaceState({ list: true }, '', location.href)
		history.pushState({ thread: id }, '', hrefOf(id))
	} else history.replaceState(history.state, '', hrefOf(id))
	drawer(null)
}

/** The phone bar's back: the list the thread was opened from, else the list opened anew */
export function backToList() {
	if (history.state?.thread) history.back()
	else drawer('list')
}

addEventListener('popstate', (event) => {
	if (event.state?.list) document.body.classList.add('list')
	else if (event.state?.thread) {
		setPage({ kind: 'threads' })
		setCurrent(event.state.thread)
		drawer(null)
	}
})

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
	for (const key of PAGE_PARAMS) next.searchParams.delete(key)
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
	caughtUp,
	write,
} = createRoot(() => {
	// ── One versioned feed, one in-memory store ──
	let socket = null
	const sendSocket = (frame) => {
		if (socket?.readyState === 1) socket.send(JSON.stringify(frame))
	}
	/** Active views on this page, keyed by view name: `{ seq, synced, map, rows, setRows, waiters, refs, sort, heard }` */
	const views = new Map()
	const orderOf = (view) => {
		const list = [...view.map.values()]
		return view.sort ? list.sort(view.sort) : list
	}
	/** Whether a view has what a write at `seq` made; a write from before a restart (another `boot`) never comes, so it has */
	const reached = (view, seq, boot) =>
		Boolean(boot && view.boot && boot !== view.boot) || (view.synced && (view.seq ?? -1) >= seq)
	const wakeWaiters = (view, force = false) => {
		view.waiters = view.waiters.filter((waiter) => {
			if (!force && !reached(view, waiter.seq, waiter.boot)) return true
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
			if (frame.view.startsWith('thread/'))
				heardThread(Number(frame.view.slice('thread/'.length)), view.map, reset)
			view.heard?.(view.map, frame, reset)
		}
		wakeWaiters(view, reset)
	}
	/** `heard(rows, frame, reset)` hears each frame that changed the view, for a caller that takes its rows apart */
	const subscribeView = (name, { sort, heard } = {}) => {
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
				heard,
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
		if (!view || reached(view, seq, boot)) return Promise.resolve()
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
	/** Whether a reload would bring newer client files or a server that changed since this page loaded; `stale`
	 * on the server says its own code changed since it started, which takes a restart */
	const behind = createMemo(() => {
		const now = server().client
		return Boolean(loadedWith && now && now !== loadedWith)
	})
	/** The subjects of the commits since the one this page loaded on, newest first; none when the server isn't a checkout */
	const [changes, setChanges] = createSignal([])
	createEffect(
		() => (behind() || server().stale) && server().commit,
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
	const bothLists = ({ seq, boot }) =>
		Promise.all([caughtUp('threads', seq, boot), caughtUp('archived', seq, boot)])
	/** The row moves the moment you ask; if the server refuses, it moves back and this throws why */
	const moveRow = (id, archived) => {
		if (archived && id === current()) openThread(null)
		const moving = (archived ? threads : archivedThreads).find((row) => row.id === id)
		const moved = moving ? { ...snapshot(moving), archived } : null
		if (archived) {
			setOptimisticThreads((rows) => rows.filter((row) => row.id !== id))
			if (moved) setOptimisticArchived((rows) => [moved, ...rows].sort(byNewest))
		} else {
			setOptimisticArchived((rows) => rows.filter((row) => row.id !== id))
			if (moved) setOptimisticThreads((rows) => [moved, ...rows].sort(byNewest))
		}
	}
	const archiveThread = action(function* (id, archived) {
		moveRow(id, archived)
		yield bothLists(yield write(`/api/threads/${id}/archive`, { archived }))
	})
	const renameThread = action(function* (id, title) {
		const patch = (rows) => rows.map((row) => (row.id === id ? { ...row, title } : row))
		setOptimisticThreads(patch)
		setOptimisticArchived(patch)
		yield bothLists(yield write(`/api/threads/${id}/title`, { title }))
	})
	/** Forgetting a bot archives its home too */
	const forgetBot = action(function* (name) {
		const home = bots.find((row) => row.name === name)?.home
		setOptimisticBots((rows) => rows.filter((row) => row.name !== name))
		if (home) moveRow(home, true)
		const { seq, boot } = yield write(`/api/bots/${encodeURIComponent(name)}`, undefined, 'DELETE')
		yield Promise.all([caughtUp('bots', seq, boot), bothLists({ seq, boot })])
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
	onSettled(() => {
		connect(
			applyFrame,
			(ws) => {
				socket = ws
				if (restarting() === 'down') location.reload()
				setConnected(true)
				// What's on screen comes first: the open thread before the lists
				for (const [name, view] of [...views].sort(
					([a], [b]) => b.includes('/') - a.includes('/'),
				)) {
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
				if (restarting() === 'asked') setRestarting('down')
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
		if (untrack(page).kind !== 'threads') openThread(untrack(current))
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
		caughtUp,
		write,
	}
})

/** What stops until you act: open questions and failed runs. The inbox's count is these, never unread answers. */
export const waiting = () => inbox.filter((item) => item.kind !== 'answered')

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
