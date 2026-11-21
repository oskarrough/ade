/** Solid's "why did this run" engine, for an agent chasing a cost warning: load it before the page's own scripts,
 * `agent-browser --session <yours> --init-script <repo>/scripts/solid-attribution.js open <url>`. The console then adds
 * the attribution codes (`WIDE_SCOPE_DEPS` names a scope's sources, `HOT_SCOPE_*`, `UNSTABLE_LIST_IDENTITY`), and
 * `eval 'JSON.stringify(solid.costs())'` ranks scopes and writes by cost. */
{
	// Served by ade beside the dev build the import map loads, so both share one graph
	const engine = '/packages/@solidjs/signals/dev.attribution.js'
	import(engine).then((attribution) => {
		attribution.attribution.enable()
		window['solid'] = attribution
	})
}
