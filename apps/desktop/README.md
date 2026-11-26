# arbe desktop

ade in its own window: the page an ade server serves, in the system's webview (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS), with its own name and icon. It's a small Go app on [mygo](https://mygo.run); the client stays as it is, with no build step.

- It opens any ade address, localhost or a Tailscale one, and remembers it, with the window's size and place and the thread you closed it on.
- Links to other sites open in the browser.
- When the server doesn't answer, it shows a page that checks again every two seconds and goes back to where you were once it does. That page also lets you switch to another server.
- While the window is in the background, a thread that finishes or waits for you shows a notification; clicking it opens the thread. On Windows these are the notification area's toasts.
- Right-click a thread in the sidebar, or a message, for a real menu: Rename, Fork, Archive; Quote, Copy. The menus are the client's (apps/client/desktop.js), so a browser keeps its own.
- On plain http over Tailscale, where the page gets no clipboard, copying goes through the app.
- It updates itself: 10 seconds after launch and every hour, it checks this repo's `desktop-v*` releases and shows the update window when there's a newer one.

Changes to ade itself need none of this: the window loads the client from the server, and ade has releases of its own (`pnpm release`). A new desktop release is only for changes in this folder. The update window is the updater's own: it can't check quietly without installing unasked, so a newer app still opens it, and if you put it off, the page's Update opens it again.

## The house

When the window's address is on this machine (localhost) and nothing answers, arbe desktop can start ade itself: on Windows inside WSL, elsewhere directly, in a login shell, so it finds node and ade as your terminal does. It asks the first time.

If ade isn't installed there, the app keeps its own: the first start fetches ade's newest release (a `v*` tag, never main) and its packages into `~/.local/share/arbe-desktop/ade`, and Node into `~/.local/share/arbe-desktop/node` when the shell has no Node 24 or newer. That takes a minute or so, and the waiting page shows each step. Every hour after, the app looks for a newer release and readies it in `ade.next` beside that copy; the page offers Update, and the restart, or the house's next start, swaps it in. Nothing needs installing first.

A release goes in only if its files match the signature in its tag, made with the update key below, so neither GitHub nor anyone between can hand the app other code. It also has to fit: a release names the oldest arbe desktop it works in, `engines["arbe-desktop"]` in its package.json, and an older app keeps the release it has and says it needs updating, with a button that opens its update window. The release it replaced stays in `ade.old` until the new one is listening; if it stops before that, the house goes back to `ade.old` and passes that release over until there's a newer one. Settings shows both versions, ade's and the app's.

Models are pi's: the runner uses the logins pi keeps in `~/.pi/agent/auth.json`. While the house's runner has only echo, the model picker offers "Log in to a model", which opens pi in a terminal (your own pi, or the one that came with ade); type `/login` there, and the picker lists the models once you're back in the window. The server keeps running when you close the window, so agents finish their work. If something already answers, it starts nothing.

The window comes in as the house's owner on this machine, as the CLI does: at launch it reads `owner.key` beside the store (`DB_PATH`'s folder, else `~/.local/share/ade`) and keeps it as the cookie the server reads, which no script on the page can read and which goes only to localhost, until the app quits. With `"invites": true` in ade.json that's the only way in; with invites off, localhost was enough anyway. A server elsewhere, on a tailnet, gets no key; open the link `ade link` prints there.

To update, the page's Update button restarts the server in place when its code changed or a newer release is ready, wherever it was started, and reloads once it's back. The House menu (in the menu bar on macOS, beside the usual Edit and View; Alt or F10 on Windows) has only the switch, Start house when it's down, which starts it at once if nothing answers, and the house log, with startup crashes: `~/.local/state/arbe-desktop/house.log` (in WSL on Windows). `house.sh` keeps the house's process group and a token in `~/.local/state/arbe-desktop/house.pid`; to stop it, `kill -TERM -- -<pid>` with that file's first word.

What it runs lives in `house.json` beside the app's settings (`%AppData%\arbe desktop` on Windows): `start`, `dir` (default `~`) and `command` (default `ade`). Or set it once from a terminal:

```
"arbe desktop.exe" -house ~/sites/ade -house-command "SERVE_PORT=3001 ade"
"arbe desktop.exe" -house off
```

## Run it from source

You need Go; `go.mod` names the version MyGo needs, and `GOTOOLCHAIN=auto` fetches it if yours is older. On Linux and WSL you also need WebKitGTK 4.1 (`sudo dnf install webkit2gtk4.1`).

```sh
cd apps/desktop
GOTOOLCHAIN=auto go run . -url http://localhost:3000
```

From WSL this opens a Linux window. For the Windows app, build it and run the exe from Windows; Windows reaches WSL's localhost without any setup.

```sh
GOTOOLCHAIN=auto go tool mygo build -platform windows/amd64   # dist/windows-amd64/: the exe and its installer
```

`dist/` is ignored. A build made here calls itself `0.1.8-local` in Settings, so you can tell it from a release; only GitHub's builds drop the `-local`. Windows installers also need NSIS (`sudo dnf install mingw32-nsis`).

## Release a new version

1. Add a section to the top of `CHANGELOG.md`, `## 0.1.7` with a few lines under it, and push it to main. Its version is the app's version, and its lines are the notes the update window shows.
2. Run `pnpm desktop:release`.

That tags main `desktop-v0.1.7` and pushes the tag. GitHub Actions ([desktop-release.yml](../../.github/workflows/desktop-release.yml)) checks the tag against `CHANGELOG.md`, builds Windows, Linux and macOS, signs the updates, uploads them and publishes the release as the repo's latest. Installed apps find it within the hour, or 10 seconds after they next start. If a build fails, "Re-run failed jobs" builds it again into the same draft.

Each release also carries copies under names without the version, so these links always get the newest:

- https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-windows.exe
- https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-mac.dmg (one app for Apple silicon and Intel)
- https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-linux.tar.gz, or `curl -fsSL https://github.com/oskarrough/ade/releases/latest/download/install.sh | sh`, which installs it in `~/.local`

The versioned files beside them are what updates use: apps look for the newest `desktop-v*` release and its `update-<platform>.json`, so renaming those would strand installs.

## The update key

Releases are signed with a key pair, the app's and ade's (`pnpm release` signs those too). The public half is in `mygo.config.ts`; the secret half is the repo's Actions secret `MYGO_UPDATER_PRIVATE_KEY`, and at

```
~/.config/mygo/update-keys/mygo-update.key   (WSL, Oskar's machine)
```

and belongs in the password manager too. Installed apps take only updates signed with it: losing it strands every install on its version, and anyone who has it can ship code to them. On another machine, put it back at that path, or point `MYGO_UPDATER_KEY_FILE` at it, or pass its contents in `MYGO_UPDATER_PRIVATE_KEY`. Never commit it.

## Unsigned, for now

The apps aren't code-signed.

- Windows: running a downloaded installer, SmartScreen says "Windows protected your PC" with "Unknown publisher". Click "More info", then "Run anyway". Updates the app installs itself don't ask again.
- macOS: an app from another Mac is signed ad hoc, and Gatekeeper refuses it: "Apple could not verify "arbe desktop" is free of malware". Open it once from System Settings › Privacy & Security › Open Anyway. Signing and notarizing take an Apple Developer ID.
- Linux asks nothing.
