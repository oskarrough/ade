import { randomBytes } from 'node:crypto'

/**
 * One versioned feed per socket: each subscribed view holds its last sent rows and `seq` (Pi Durable's commit seq,
 * bumped on non-commit `touch`es too). Commits and touches recompute only affected views and send minimal `put`/`del`
 * envelopes; reconnecting with `after` gets a delta while the view stays cached, else `reset: true`.
 */
export function createFeed() {
	const boot = randomBytes(8).toString('hex')
	let seq = 0
	/** @type {Map<string, any>} */
	const specs = new Map()
	/** @type {Map<string, any>} */
	const states = new Map()
	const IDLE_MS = 60_000
	const MAX_DELETED = 500
	const MAX_IDLE = 64

	const parse = (view) => {
		const [base, search] = view.split('?', 2)
		const query = new URLSearchParams(search ?? '')
		if (specs.has(base)) return { spec: specs.get(base), param: undefined, query }
		const slash = base.indexOf('/')
		const spec = slash >= 0 && specs.get(base.slice(0, slash + 1))
		return spec ? { spec, param: base.slice(slash + 1), query } : null
	}

	const sendFrame = (socket, view, payload, at) => {
		if (socket.readyState !== 1) return
		socket.send(payload)
		socket.sentSeq.set(view, at)
	}

	const scheduleFlush = (state) => {
		if (!state.subs.size || !state.dirty || state.scheduled || state.flushing) return
		state.scheduled = true
		queueMicrotask(() => {
			state.scheduled = false
			if (state.subs.size && state.dirty) void flushState(state)
		})
	}

	const markDirty = (state, keys) => {
		if (keys === true || !state.spec.rows) state.dirty = true
		else if (state.dirty !== true) {
			state.dirty ||= new Set()
			for (const key of keys) state.dirty.add(key)
		}
		state.dirtySeq = seq
		scheduleFlush(state)
	}

	const applyDiff = (state, nextRows, partial, targetSeq) => {
		const put = []
		const del = []
		const keyOf = state.spec.keyOf ?? ((row) => row.id)
		const putRow = (key, row) => {
			const json = JSON.stringify(row)
			if (state.rows.get(key)?.json === json) return
			state.rows.set(key, { seq: targetSeq, json, row })
			state.deleted.delete(key)
			put.push({ key, seq: targetSeq, row })
		}
		const delRow = (key) => {
			if (!state.rows.delete(key)) return
			state.deleted.set(key, targetSeq)
			del.push(key)
		}
		if (partial) {
			for (const [key, row] of nextRows)
				if (row == null) delRow(key)
				else putRow(key, row)
		} else {
			const seen = new Set()
			for (const row of nextRows) {
				const key = keyOf(row)
				seen.add(key)
				putRow(key, row)
			}
			for (const key of state.rows.keys()) if (!seen.has(key)) delRow(key)
		}
		if (state.deleted.size > MAX_DELETED) {
			let drop = state.deleted.size - MAX_DELETED
			for (const [key, delSeq] of state.deleted) {
				state.deleted.delete(key)
				if (delSeq > state.sinceSeq) state.sinceSeq = delSeq
				if (--drop <= 0) break
			}
		}
		if (targetSeq > state.seq) state.seq = targetSeq
		return { put, del }
	}

	const flushState = (state) => {
		if (state.flushing) return state.flushing
		state.flushing = (async () => {
			while (state.dirty) {
				const work = state.dirty
				const targetSeq = Math.max(state.dirtySeq ?? seq, seq)
				state.dirty = false
				const partial = work !== true && Boolean(state.spec.rows)
				const next = partial
					? await state.spec.rows([...work], state.viewer, state.param, state.query, state)
					: await state.spec.all(state.viewer, state.param, state.query, state)
				const diff = applyDiff(state, next, partial, targetSeq)
				if ((diff.put.length || diff.del.length) && state.subs.size) {
					const payload = JSON.stringify({ view: state.view, boot, seq: state.seq, ...diff })
					for (const socket of state.subs) sendFrame(socket, state.view, payload, state.seq)
				}
			}
		})()
			.catch((error) => console.error(`feed ${state.view}: ${error.message}`))
			.finally(() => {
				state.flushing = null
				scheduleFlush(state)
			})
		return state.flushing
	}

	const evict = (state) => {
		states.delete(state.cacheKey)
		state.spec.drop?.(state)
	}
	const armEviction = (state) => {
		clearTimeout(state.evict)
		state.evict = setTimeout(() => {
			if (!state.subs.size) evict(state)
		}, IDLE_MS)
		state.evict.unref()
		let idle = 0
		for (const each of states.values()) if (!each.subs.size) idle++
		for (const each of states.values()) {
			if (idle <= MAX_IDLE) break
			if (!each.subs.size && each !== state) {
				clearTimeout(each.evict)
				evict(each)
				idle--
			}
		}
	}

	const onSocket = (socket, run) =>
		(socket.feedQueue = (socket.feedQueue ?? Promise.resolve()).then(run).catch(() => {}))

	return {
		boot: () => boot,
		seq: () => seq,
		define: (name, spec) => specs.set(name, spec),
		hasSubscribers: (view) =>
			[...states.values()].some(
				(state) => state.subs.size && (state.view === view || state.view.startsWith(`${view}?`)),
			),
		onCommit: (publication) => {
			seq = Math.max(seq + 1, publication.seq)
			for (const state of states.values()) {
				if (!state.ready) continue
				let dirty = /** @type {false | true | Set<any>} */ (false)
				for (const change of publication.changes) {
					const hit = state.spec.match?.(change, state.param, state)
					if (!hit) continue
					if (hit === true) {
						dirty = true
						break
					}
					if (dirty !== true) {
						dirty ||= new Set()
						for (const key of hit) dirty.add(key)
					}
				}
				if (dirty) markDirty(state, dirty)
			}
		},
		touch: (views, key) => {
			seq++
			const names = Array.isArray(views) ? views : [views]
			for (const state of states.values()) {
				if (!state.ready) continue
				if (names.some((view) => state.view === view || state.view.startsWith(`${view}/`)))
					markDirty(state, key === undefined ? true : [key])
			}
		},
		subscribe: (socket, view, after, afterBoot) =>
			onSocket(socket, async () => {
				if (typeof view !== 'string' || socket.readyState !== 1) return
				const parsed = parse(view)
				if (!parsed) return
				const { spec, param, query } = parsed
				const viewer = spec.perViewer ? socket.viewer : ''
				const cacheKey = spec.perViewer ? `${view}\0${viewer}` : view
				let state = states.get(cacheKey)
				if (!state) {
					state = {
						view,
						cacheKey,
						spec,
						param,
						query,
						viewer,
						seq: 0,
						sinceSeq: 0,
						ready: false,
						rows: new Map(),
						deleted: new Map(),
						subs: new Set(),
						dirty: false,
						dirtySeq: 0,
						scheduled: false,
						flushing: null,
						evict: null,
						/** For a spec that hears more than commits: these rows changed */
						touch: (keys) => {
							seq++
							markDirty(state, keys)
						},
					}
					states.set(cacheKey, state)
				}
				clearTimeout(state.evict)
				state.evict = null
				if (!state.ready) {
					state.flushing ??= (async () => {
						const at = seq
						applyDiff(state, await spec.all(viewer, param, query, state), false, at)
						state.sinceSeq = at
						state.ready = true
					})().finally(() => {
						state.flushing = null
						scheduleFlush(state)
					})
					await state.flushing
				}
				if (state.dirty || state.flushing) await flushState(state)
				if (socket.readyState !== 1) {
					if (!state.subs.size) armEviction(state)
					return
				}
				const delta =
					afterBoot === boot &&
					typeof after === 'number' &&
					after >= state.sinceSeq &&
					after <= state.seq
				const frame = {
					view,
					boot,
					seq: state.seq,
					...(!delta && { reset: true }),
					put: [...state.rows.entries()]
						.filter(([, entry]) => !delta || entry.seq > after)
						.map(([key, entry]) => ({ key, seq: entry.seq, row: entry.row })),
					del: delta
						? [...state.deleted.entries()].filter(([, at]) => at > after).map(([key]) => key)
						: [],
				}
				sendFrame(socket, view, JSON.stringify(frame), state.seq)
				state.subs.add(socket)
				socket.subs.set(view, state)
			}),
		unsubscribe: (socket, view) =>
			onSocket(socket, () => {
				const state = socket.subs?.get(view)
				if (!state) return
				state.subs.delete(socket)
				socket.subs.delete(view)
				if (!state.subs.size) armEviction(state)
			}),
		sync: (socket, view, targetSeq) =>
			onSocket(socket, async () => {
				const state = socket.subs?.get(view)
				if (!state || socket.readyState !== 1) return
				if ((socket.sentSeq.get(view) ?? -1) >= targetSeq) return
				if (state.dirty || state.flushing) await flushState(state)
				if (socket.readyState !== 1 || (socket.sentSeq.get(view) ?? -1) >= targetSeq) return
				const at = Math.max(state.seq, seq)
				sendFrame(socket, view, JSON.stringify({ view, boot, seq: at, put: [], del: [] }), at)
			}),
		disconnect: (socket) => {
			for (const state of socket.subs?.values() ?? []) {
				state.subs.delete(socket)
				if (!state.subs.size) armEviction(state)
			}
			socket.subs?.clear()
		},
	}
}
