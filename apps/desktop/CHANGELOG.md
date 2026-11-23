# Changelog

## 0.1.7

- Starts your house without ade installed: it fetches ade from GitHub with npx, pnpx or bunx, so Node 24 is all you need.

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
