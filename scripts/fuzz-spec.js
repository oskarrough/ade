/**
 * What `pnpm fuzz` holds ade to while Bombadil clicks, types and reloads its way around a scratch server: no errors,
 * drafts that survive leaving and reloading, sends that land or come back, and a sidebar that lists each thread once.
 * Each export is a property or an action Bombadil picks from; https://antithesishq.github.io/bombadil/ has the language.
 */
import { always, eventually, next, now } from '@antithesishq/bombadil'
import { actions, extract, getFingerprint, weighted } from '@antithesishq/bombadil/browser'

export {
	noUncaughtExceptions,
	noUnhandledPromiseRejections,
	noConsoleErrors,
	noHttpErrorCodes,
} from '@antithesishq/bombadil/browser/defaults/properties'
export {
	clicks,
	inputs,
	scroll,
	navigation,
	waitOnce,
} from '@antithesishq/bombadil/browser/defaults/actions'

/**
 * Restarting takes the server down a moment, a reload then lands on Chrome's error page, and there Bombadil offers only
 * Back and, with no page behind, stops. Bombadil clicks a point, not an element, so controls that would restart the server
 * carry `data-fuzz-skip` and this disables them in the page; crashes and restarts are `pnpm fuzz --crash`'s. The property
 * only makes Bombadil run it on every state.
 */
const skipped = extract((state) => {
	for (const control of state.document.querySelectorAll('[data-fuzz-skip]'))
		control.setAttribute('disabled', '')
	return true
})
export const serverStaysUp = always(() => skipped.current)

// Text crosses to Bombadil as JSON, and a lone half of a surrogate pair, which its random typing can leave, stops it dead
const composer = extract((state) => {
	const box = /** @type {HTMLTextAreaElement | null} */ (
		state.document.querySelector('article.thread.current form.compose textarea.draft')
	)
	if (!box) return null
	const thread = new URL(state.window.location.href).searchParams.get('thread') ?? 'new'
	return { thread, draft: box.value.toWellFormed() }
})
const transcript = extract(
	(state) =>
		state.document.querySelector('article.thread.current > ul')?.textContent?.toWellFormed() ?? '',
)
const lastAction = extract((state) => {
	const action = state.lastAction
	if (!action) return null
	if (typeof action === 'string') return action
	if ('PressKey' in action) return `key ${action.PressKey.code}`
	if ('Click' in action) return `click ${action.Click.fingerprint.accessibleName ?? ''}`
	return Object.keys(action)[0]
})

/** Letters and digits only, so markdown rendering doesn't hide a message that did arrive */
const plain = (text) => (text ?? '').replace(/[^\p{L}\p{N}]/gu, '')
/**
 * A draft changes only while its composer is open: coming back to a thread finds its draft as it was left, or, for a text
 * a send took, gone or back if the send never landed. After a reload or a step through history Bombadil looks once the
 * page has gone quiet, so the draft must be there at once; moving within the page it loads from the server and gets two
 * seconds, and typing before it arrives leaves nothing to judge.
 * The bookkeeping runs in the page and keeps to sessionStorage, which outlasts the reloads; it answers what was lost, or null.
 */
const lostDraft = extract((state) => {
	// What's typed counts at once: a fork opening as the keys land moves to another thread before this looks again
	if (!state.document.documentElement.dataset.fuzzDrafts) {
		state.document.documentElement.dataset.fuzzDrafts = '1'
		state.document.addEventListener(
			'input',
			(event) => {
				const target = /** @type {HTMLElement} */ (event.target)
				if (!target.matches?.('form.compose textarea.draft')) return
				const saved = JSON.parse(state.window.sessionStorage.getItem('fuzz-drafts') ?? 'null')
				if (!saved) return
				const thread = target.closest('article.thread')?.getAttribute('data-thread') || 'new'
				saved.left[thread] = /** @type {HTMLTextAreaElement} */ (target).value.toWellFormed()
				if (saved.showing === thread) saved.loading = null
				state.window.sessionStorage.setItem('fuzz-drafts', JSON.stringify(saved))
			},
			true,
		)
		// A send counts as its form goes, before the box empties: Bombadil's name for the Send icon can come up empty
		state.document.addEventListener(
			'submit',
			(event) => {
				const form = /** @type {HTMLElement} */ (event.target)
				const text = form.matches?.('form.compose')
					? (/** @type {HTMLTextAreaElement | null} */ (
							form.querySelector('textarea.draft')
						)?.value.toWellFormed() ?? '')
					: ''
				const saved = JSON.parse(state.window.sessionStorage.getItem('fuzz-drafts') ?? 'null')
				if (!saved || !text.trim()) return
				saved.sent.push(text)
				state.window.sessionStorage.setItem('fuzz-drafts', JSON.stringify(saved))
			},
			true,
		)
	}
	const box = /** @type {HTMLTextAreaElement | null} */ (
		state.document.querySelector('article.thread.current form.compose textarea.draft')
	)
	const shown = box
		? {
				thread: new URL(state.window.location.href).searchParams.get('thread') ?? 'new',
				draft: box.value.toWellFormed(),
			}
		: null
	const action = state.lastAction
	const kind =
		typeof action === 'string'
			? action
			: action && 'PressKey' in action
				? `key ${action.PressKey.code}`
				: action && 'Click' in action
					? `click ${action.Click.fingerprint.accessibleName ?? ''}`
					: action
						? Object.keys(action)[0]
						: ''
	const blank = (text) => (text.trim() ? text : '')
	const memory = JSON.parse(state.window.sessionStorage.getItem('fuzz-drafts') ?? 'null') ?? {
		left: {},
		sent: [],
		showing: null,
		loading: null,
		before: null,
	}
	const save = () => state.window.sessionStorage.setItem('fuzz-drafts', JSON.stringify(memory))
	if (memory.before && ['key 13', 'click Send'].includes(kind) && blank(memory.before.draft))
		memory.sent.push(blank(memory.before.draft))
	memory.before = shown
	if (!shown) {
		memory.showing = memory.loading = null
		save()
		return null
	}
	const same = (expected, draft) =>
		blank(expected) === blank(draft) ||
		(memory.sent.includes(blank(expected)) && !blank(draft)) ||
		(memory.sent.includes(blank(draft)) && !blank(expected))
	const loaded = ['Reload', 'Back', 'Forward'].includes(kind)
	const came = loaded || memory.showing !== shown.thread
	memory.showing = shown.thread
	if (came) memory.loading = null
	const expected = came ? memory.left[shown.thread] : memory.loading?.expected
	let lost = null
	if (expected === undefined || same(expected, shown.draft)) memory.loading = null
	else if (loaded) lost = expected
	else if (came) memory.loading = { expected, by: Date.now() + 2000 }
	else if (/^(TypeText|key)/.test(kind)) memory.loading = null
	else if (Date.now() > memory.loading.by) lost = expected
	if (!memory.loading && !lost) memory.left[shown.thread] = shown.draft
	save()
	return lost === null ? null : { thread: shown.thread, was: lost, now: shown.draft }
})
export const draftsSurvive = always(() => lostDraft.current === null)

/** Sending puts the message in the thread, or back in the box; it never just disappears */
export const sendSettles = always(() => {
	const before = composer.current
	const text = plain(before?.draft)
	const sendable = text.length > 0 && !before.draft.includes('@') && !/^\$\s/.test(before.draft)
	return now(() => sendable)
		.and(next(() => ['key 13', 'click Send'].includes(lastAction.current)))
		.implies(
			eventually(
				() =>
					plain(transcript.current).includes(text) || plain(composer.current?.draft).includes(text),
			).within(10, 'seconds'),
		)
})

const sidebar = extract((state) =>
	[...state.document.querySelectorAll('nav.thread-list a.row')]
		.map((row) => row.getAttribute('href') ?? '')
		.filter((href) => href.includes('thread=')),
)
/** The sidebar lists each thread once */
export const sidebarListsOnce = always(
	() => sidebar.current.length === new Set(sidebar.current).size,
)

const box = extract((state) => {
	const element = state.document.querySelector('article.thread.current form.compose textarea.draft')
	if (!element) return null
	const rect = element.getBoundingClientRect()
	const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
	// Bombadil refuses a point off the screen, as the box is while the page scrolls or a phone's keyboard opens
	const onScreen =
		point.x >= 0 &&
		point.y >= 0 &&
		point.x < state.window.innerWidth &&
		point.y < state.window.innerHeight
	if (!rect.width || !rect.height || !onScreen) return null
	return { fingerprint: getFingerprint(element), point }
})
/** Plain words into the composer, and Enter, so messages actually get sent */
export const writing = weighted([
	[3, actions(() => (box.current ? [{ Click: box.current }] : []))],
	[3, actions(() => [{ TypeText: { text: { Regexp: '[a-z]{2,8}( [a-z]{2,8}){0,4}' } } }])],
	[2, actions(() => [{ PressKey: { code: 13 } }])],
])
