/** The client's icons: one set of strokes on a 24-unit grid at a stroke of 2, drawn in the button's own colour and sized by base.css's `svg.icon` to 16px or, beside small text, 12px, so the stroke is 1.33px or 1px wherever they sit */
import html from '@solidjs/html'

const paths = {
	up: 'M12 19V5M6 11l6-6 6 6',
	back: 'M15 6l-6 6 6 6',
	plus: 'M12 5v14M5 12h14',
	close: 'M6 6l12 12M18 6L6 18',
	next: 'M9 6l6 6-6 6',
	check: 'M5 12l5 5 9-10',
	search: 'M20 20l-4.35-4.35M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 1 1 13 0',
	// The clock's face is the schedule ring's circle
	clock: 'M12 8v4l2.5 2.5M20 12a8 8 0 1 1-16 0 8 8 0 1 1 16 0',
	// An open book, the walkthrough the settings go back to
	story:
		'M12 6.5C10.5 5 8 4.5 4 5v13c4-.5 6.5 0 8 1.5 1.5-1.5 4-2 8-1.5V5c-4-.5-6.5 0-8 1.5zM12 6.5v13',
	again: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5',
	// Six teeth and an open hub, few enough to stay a gear at 16px
	settings:
		'M9.69 5.66L10.24 2.92L13.76 2.92L14.31 5.66L16.34 6.83L18.98 5.93L20.75 8.99L18.65 10.83L18.65 13.17L20.75 15.01L18.98 18.07L16.34 17.17L14.31 18.34L13.76 21.08L10.24 21.08L9.69 18.34L7.66 17.17L5.02 18.07L3.25 15.01L5.35 13.17L5.35 10.83L3.25 8.99L5.02 5.93L7.66 6.83ZM14.25 12a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 1 1 4.5 0',
}

export const Icon = (props) =>
	html`<svg
		class="icon"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<path d=${() => paths[props.name]} />
	</svg>`
