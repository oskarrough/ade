// Browser-only CDN modules have no locally installed declarations.
/* oxlint-disable typescript/no-explicit-any -- Types stop at this CDN import boundary. */
declare module 'https://esm.sh/tldraw@*' {
	export const allDefaultFontFaces: any
	export const Tldraw: any
}
