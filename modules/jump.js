/**
 * Cmd-K or Ctrl-K (Cmd-O and Ctrl-O too) opens one field that jumps to any thread, archived ones included, any bot,
 * or an action like New thread or Settings; with `search` on, a typed phrase lists matching messages too.
 * The client does it all: this file only switches it, off by default.
 */
export const on = false

/** Nothing on the server; being listed among the server's modules is what turns it on in the client */
export const server = () => ({})
