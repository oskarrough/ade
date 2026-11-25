# Changelog

## 0.1.11

- A release of ade that needs your threads converted first stays put, stopped, and shows the command to run, instead of going back to the one before and never coming again.

## 0.1.10

- Takes only releases of ade signed with its own update key, and only those it's new enough for; for a release that needs a newer arbe desktop, it says so and offers its own update.
- A release of ade that won't start goes back to the one before it by itself, and waits for the next.
- Settings shows ade's version beside arbe desktop's, for bug reports.

## 0.1.9

- Comes in as the owner of a house on this machine when its invites are on, with the owner key from beside its store, as the CLI does; before, the window got "Who are you?".

## 0.1.8

- "Log in to a model" in the model picker, while only echo answers: it opens pi in a terminal, where `/login` logs you in, and the picker lists the models when you're back.
- On macOS, Cmd+A, C, V, X and Z work again: the menu bar has its Edit menu back, beside House.
- On macOS, the window buttons sit level with the top row's Search, Thread and Bot.

## 0.1.7

- Works with nothing installed (on Windows, nothing but WSL): without ade, the first start fetches it, and Node when there's none, and the waiting page shows how far it got.
- Keeps that ade up to date: every hour it fetches main, and the page offers Update.
- When the house stops while you wait, the page shows the log's last lines, and Try now starts it again.

## 0.1.6

- The House menu holds just "Start house when it's down" and "Open house log": ticking the switch starts a house that's down.
- The first release built on GitHub, with download links that always point at the newest version.

## 0.1.5

- Starts your house: when nothing answers at a localhost address, arbe desktop starts the ade server and its runner (inside WSL on Windows) and leaves them running when you close the window. It asks once; the House menu (Alt) turns it off, starts or stops the house it started, and opens its log.

## 0.1.4

- Settings shows which arbe desktop you're running, at the bottom.

## 0.1.3

- Dropped the grey title bar so ade's top row reaches the window edge, with native window buttons inline and drag-to-move on empty space.

## 0.1.2

- Added native right-click menus on sidebar threads (Open, Rename, Fork, Copy link, Archive) and messages (Quote, Copy, Fork from here — using selected text when highlighted).

## 0.1.1

- Added a Try now button on the offline page to reconnect immediately instead of waiting for the next retry.

## 0.1.0

- Runs ade in its own desktop window with its own name and icon, connected to any localhost or Tailscale server.
- Remembers window size, position, and the last open thread across restarts.
- Opens external links in your default browser.
- Sends desktop notifications when a background thread finishes or needs input; clicking opens the thread.
- Shows a self-reconnecting offline page when the server is unreachable, with an option to switch servers.
- Checks for and installs app updates automatically.
