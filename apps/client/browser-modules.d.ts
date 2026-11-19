// Browser-only CDN modules have no locally installed declarations.
/* oxlint-disable typescript/no-explicit-any -- Types stop at this CDN import boundary. */
declare module 'https://esm.sh/tldraw@*' {
	export const allDefaultFontFaces: any
	export const Tldraw: any
}
declare module 'https://esm.sh/diff@*' {
	export function diffWords(
		before: string,
		after: string,
	): Array<{ added?: boolean; removed?: boolean; value: string }>
}
