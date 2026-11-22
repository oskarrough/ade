// Runs in the ade page before its own scripts. ade has no notifications of its
// own, so this watches the thread list the page fetches anyway and tells the
// app when a thread finishes or starts waiting for you.
;(() => {
	/** The app's runtime, which MyGo puts on every page before this runs */
	const { mygo } = /** @type {any} */ (window)
	if (!mygo) return
	const mark = () => {
		document.documentElement.dataset.desktop = ''
	}
	if (document.documentElement) mark()
	else document.addEventListener('DOMContentLoaded', mark, { once: true })
	// Plain http to a tailnet address isn't a secure context, so the page has no
	// navigator.clipboard; the app's clipboard stands in.
	if (!navigator.clipboard)
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: (text) => mygo.call('Desktop.WriteText', String(text)),
				readText: () => mygo.call('Desktop.ReadText'),
			},
		})
	const seen = new Map()
	let primed = false
	const watch = (rows) => {
		for (const row of rows) {
			const before = seen.get(row.id)
			seen.set(row.id, row.status)
			if (!primed || before === row.status) continue
			if (row.status === 'blocked')
				mygo.call('Desktop.Notify', row.id, row.title, 'Waiting for you')
			else if (before === 'working' && row.status !== 'working')
				mygo.call('Desktop.Notify', row.id, row.title, 'Done')
		}
		primed = true
	}
	const fetch = window.fetch
	window.fetch = function (input, init) {
		const answer = fetch.call(this, input, init)
		const path = new URL(input instanceof Request ? input.url : String(input), location.href)
			.pathname
		if (path === '/api/threads')
			answer
				.then((response) => response.clone().json())
				.then((rows) => Array.isArray(rows) && watch(rows))
				.catch(() => {})
		return answer
	}
})()
