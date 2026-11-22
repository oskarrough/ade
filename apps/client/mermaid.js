/** Load Pele once, when a closed message block or the walkthrough needs it. */
let loading, loaded
let diagramId = 0
const load = () =>
	(loading ??= import('pele').then(
		(pele) => (loaded = pele),
		() => null,
	))

/** Keep each rendered block and its open source across updates to the rest of a streaming message. */
export function messageDiagrams(element) {
	const diagrams = new Map()
	return (markup) => {
		element.innerHTML = markup
		if (!markup.includes('data-mermaid')) return
		const blocks = [...element.querySelectorAll('pre[data-mermaid]')]
		const counts = new Map()
		function draw(pele) {
			for (const block of blocks) {
				if (!element.contains(block)) continue
				const source = block.textContent.trimEnd()
				const count = counts.get(source) ?? 0
				counts.set(source, count + 1)
				const key = JSON.stringify([source, count])
				if (!diagrams.has(key)) {
					try {
						const { svg } = pele.render(source, {
							responsive: false,
							idPrefix: `message-diagram-${++diagramId}-`,
							links: false,
							images: false,
						})
						const diagram = document.createElement('div')
						diagram.className = 'message-diagram'
						diagram.innerHTML = `<div class="diagram">${svg}</div><details><summary>Source</summary></details>`
						diagram.lastElementChild.append(block.cloneNode(true))
						diagrams.set(key, diagram)
					} catch {
						diagrams.set(key, null) // Keep the plain code block on a parse or render error.
					}
				}
				const diagram = diagrams.get(key)
				if (diagram) block.replaceWith(diagram)
			}
		}
		if (loaded) draw(loaded)
		else if (blocks.length)
			void load().then((pele) => {
				if (pele) draw(pele)
			})
	}
}

export async function storyDiagram() {
	const source = document.querySelector('pre.mermaid')
	if (!source) return
	const pele = await load()
	if (!pele || !source.isConnected) return
	const diagram = document.createElement('div')
	diagram.className = 'diagram'
	source.replaceWith(diagram)
	pele.mount(diagram, source.textContent, { zoom: false })
}
