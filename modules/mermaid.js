/** Renders Mermaid code blocks as diagrams in messages. */
import { defineExtension } from '@earendil-works/pi-durable'

export const on = false

export function server() {
	return {
		extension: defineExtension({
			name: 'ade.mermaid',
			sections: [
				{
					key: 'mermaid',
					tag: false,
					render: () =>
						'When a diagram would explain something better than prose, write it in a fenced `mermaid` code block.',
				},
			],
		}),
	}
}
