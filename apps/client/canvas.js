/**
 * A thread's canvas, a page of the side column: tldraw, synced with the thread's room on the server, where agents draw
 * too. tldraw is React, so it's an island here, loaded from esm.sh when a canvas first opens (React ships no modules a
 * browser can import, and tldraw is some 150 packages), at the version the server's room speaks.
 *
 * A tab only shows the board: agents draw on the server's room, which can't lay text out, so a tab grows any shape whose
 * label doesn't fit, as tldraw does when a label is typed (fitLabels), and tells the server what the person has selected
 * and in view, so an agent's look knows what "this box" is (reportSeen).
 */
import html from '@solidjs/html'
import { createSignal, onSettled, Show, untrack } from 'solid-js'
import { shortLabel } from './agent.js'
import { Panes } from './panes.js'
import { openSide, PageTabs } from './side.js'
import { api, colorOf, me, url } from './server.js'
import { Stamp } from './time.js'

/** The versions canvas/tldraw.js loads; the server's @tldraw/sync-core must be the same */
const TLDRAW = '5.6.1'
const REACT = '19.3.0'
const deps = `deps=react@${REACT},react-dom@${REACT}`

/** React, react-dom and tldraw as one set of modules, fetched once a page */
let loading
const load = () =>
	(loading ??= (async () => {
		const css = document.createElement('link')
		css.rel = 'stylesheet'
		css.href = `https://esm.sh/tldraw@${TLDRAW}/tldraw.css`
		document.head.append(css)
		const [react, dom, tldraw, sync] = await Promise.all([
			import(`https://esm.sh/react@${REACT}`),
			import(`https://esm.sh/react-dom@${REACT}/client?deps=react@${REACT}`),
			import('./canvas/tldraw.js'),
			import(`https://esm.sh/@tldraw/sync@${TLDRAW}?${deps}`),
		])
		return { react, dom, tldraw, sync }
	})().catch((error) => {
		loading = undefined
		throw error
	}))

/** Pasted images live in the canvas itself, as data URLs */
const assets = {
	upload: (_asset, file) =>
		new Promise((resolve, reject) => {
			const reader = new FileReader()
			reader.onload = () => resolve({ src: reader.result })
			reader.onerror = () => reject(reader.error)
			reader.readAsDataURL(file)
		}),
	resolve: (asset) => asset.props.src,
}

/** Each thread's editor while its canvas is open here, and the area to show once it opens */
const editors = new Map()
const waiting = new Map()

/** Opens a thread's canvas on an area of it, or just opens it */
export function showOnCanvas(id, box) {
	openSide(id, 'canvas')
	if (!box) return
	const editor = editors.get(id)
	if (editor) frame(editor, box)
	else waiting.set(id, box)
}
const frame = (editor, box) =>
	editor.zoomToBounds(box, { inset: 48, targetZoom: 1, animation: { duration: 300 } })

/**
 * Grows each shape whose label doesn't fit, now and as agents draw, with tldraw's own measure of the label (what its
 * shapes do when created in an editor). The room counts that as nobody's change.
 */
async function fitLabels(tldraw, editor) {
	// A font that fails to load leaves its fallback measured, as an editor would show it
	await Promise.allSettled(
		tldraw.allDefaultFontFaces.map((face) => editor.fonts.ensureFontIsLoaded(face)),
	)
	await document.fonts.ready
	const fit = (shapes) => {
		const grown = shapes.flatMap((shape) => {
			if (shape.type !== 'geo' && shape.type !== 'note') return []
			const next = editor.getShapeUtil(shape).onBeforeCreate?.(shape)
			if (!next) return []
			const { growY, fontSizeAdjustment } = next.props
			const props = shape.type === 'note' ? { growY, fontSizeAdjustment } : { growY }
			return [{ id: next.id, type: next.type, props }]
		})
		if (grown.length) editor.run(() => editor.updateShapes(grown), { history: 'ignore' })
	}
	fit(editor.getCurrentPageShapes())
	return editor.store.listen(
		({ changes }) =>
			fit(
				[
					...Object.values(changes.added),
					...Object.values(changes.updated).map(([, to]) => to),
				].filter((record) => record.typeName === 'shape'),
			),
		{ source: 'remote', scope: 'document' },
	)
}

/** How often at most a tab tells the server what its person has selected and in view */
const REPORT = 500

/**
 * Tells the server what the person has selected and in view whenever either changes, at most every REPORT ms, and that
 * they've gone when the canvas closes. tldraw sync shares this as presence, but not while someone is alone in the room.
 */
function reportSeen(tldraw, editor, id) {
	let timer,
		last = 0,
		sent = ''
	const send = () => {
		timer = undefined
		last = Date.now()
		const { x, y, w, h } = editor.getViewportPageBounds()
		const seen = { selected: editor.getSelectedShapeIds(), view: { x, y, w, h } }
		const body = JSON.stringify(seen)
		if (body === sent) return
		sent = body
		api(`/api/threads/${id}/canvas`, { seen }).catch(() => (sent = ''))
	}
	const stop = tldraw.react('report what the person sees', () => {
		editor.getSelectedShapeIds()
		editor.getViewportPageBounds()
		timer ??= setTimeout(send, Math.max(0, last + REPORT - Date.now()))
	})
	return () => {
		stop()
		clearTimeout(timer)
		api(`/api/threads/${id}/canvas`, { seen: null }).catch(() => {})
	}
}

/** The editor, synced with the thread's room */
function board({ react, dom, tldraw, sync }, element, id) {
	let editor, stop, unreport
	// The same options every render, or useSync starts over each time
	const options = {
		uri: `${url.replace(/^http/, 'ws')}/api/threads/${id}/canvas?user=${encodeURIComponent(me)}`,
		assets,
		userInfo: { id: me, name: me },
	}
	const onMount = (mounted) => {
		editor = mounted
		editors.set(id, mounted)
		if (waiting.has(id)) frame(mounted, waiting.get(id))
		waiting.delete(id)
		unreport = reportSeen(tldraw, mounted, id)
		fitLabels(tldraw, mounted)
			.then((unlisten) => (editor === mounted ? (stop = unlisten) : unlisten()))
			.catch((error) => console.error(`canvas ${id}: ${error.message}`))
	}
	const Board = () => {
		const store = sync.useSync(options)
		return react.createElement(tldraw.Tldraw, { store, inferDarkMode: true, onMount })
	}
	const root = dom.createRoot(element)
	root.render(react.createElement(Board))
	return () => {
		stop?.()
		unreport?.()
		if (editors.get(id) === editor) editors.delete(id)
		editor = undefined
		root.unmount()
	}
}

export function Canvas(props) {
	// One thread for this page's whole life
	const id = untrack(() => props.id)
	const [failed, setFailed] = createSignal('')
	const [ready, setReady] = createSignal(false)
	let element
	onSettled(() => {
		let gone = false,
			unmount
		api(`/api/threads/${id}/canvas`)
			.then(async ({ tldraw }) => {
				if (tldraw !== TLDRAW)
					throw new Error(`The server runs tldraw ${tldraw}, this page ${TLDRAW}; they must match`)
				const modules = await load()
				if (gone) return
				unmount = board(modules, element, id)
				setReady(true)
			})
			.catch((error) =>
				setFailed(
					error.message === "Can't reach the server"
						? error.message
						: error.message.startsWith('The server runs')
							? error.message
							: `Couldn't load tldraw from esm.sh: ${error.message}`,
				),
			)
		return () => {
			gone = true
			unmount?.()
		}
	})
	return html`
		<aside class="side canvas" aria-label="Canvas">
			<${Panes}
				title="Canvas"
				head=${html`<${PageTabs} id=${id} />`}
				onClose=${(_event) => openSide(id, null)}
			>
				<${Show} when=${() => !ready()}>
					<p class="mute">${() => failed() || 'Loading the canvas…'}</p>
				<//>
				<div class="board" ref=${(el) => (element = el)}></div>
			<//>
		</aside>
	`
}

/** A canvas_act call's answer: its first line says what it did, the rest is what it touched */
function answerOf(step) {
	const [line, ...rest] = (step.result?.text ?? '').split('\n')
	try {
		return { line, ...JSON.parse(rest.join('\n')) }
	} catch {
		return { line, applied: [], shapes: [] }
	}
}

/** The area the shapes a batch touched cover, as they landed */
function areaOf(shapes = []) {
	const boxes = shapes.map((shape) => shape.bounds ?? shape).filter((box) => box.w !== undefined)
	if (!boxes.length) return undefined
	const x = Math.min(...boxes.map((box) => box.x)),
		y = Math.min(...boxes.map((box) => box.y))
	return {
		x,
		y,
		w: Math.max(...boxes.map((box) => box.x + box.w)) - x,
		h: Math.max(...boxes.map((box) => box.y + box.h)) - y,
	}
}

/**
 * An agent's batch of canvas actions, on its own row in the chat: ✎, its name, what it did ("moved 3, deleted 1").
 * Clicked, the canvas opens on what changed; opened, each action and its intent, and why any was skipped.
 */
export function CanvasRow(props) {
	const answer = () => answerOf(props.step)
	const actions = () =>
		(props.step.args.actions ?? []).map((action, at) => ({
			action,
			done: answer().applied?.[at],
		}))
	return html`
		<li class="elsewhere">
			<ol class="steps">
				<li class="call changed">
					<details>
						<summary
							title="Show it on the canvas"
							onClick=${() => showOnCanvas(props.thread, areaOf(answer().shapes))}
						>
							<span class="tool" style=${() => colorOf(props.agent.name)}
								>${() => shortLabel(props.agent.name)}</span
							>
							<span class="in">${() => `${answer().line} on the canvas`}</span>
						</summary>
						<div class="whole">
							<pre>
${() =>
	actions()
		.map(
			({ action, done }) =>
				`${action._type}${action.intent ? `: ${action.intent}` : ''}${done?.skipped ? ` (skipped: ${done.skipped})` : ''}`,
		)
		.join('\n')}</pre>
						</div>
					</details>
				</li>
			</ol>
			<${Stamp} time=${() => props.time} />
		</li>
	`
}
