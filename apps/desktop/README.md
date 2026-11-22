# arbe desktop

ade in its own window: the page an ade server serves, in the system's webview (WebView2 on Windows, WebKitGTK on Linux, WKWebView on macOS), with its own name and icon. It's a small Go app on [mygo](https://mygo.run); the client stays as it is, with no build step.

- It opens any ade address, localhost or a Tailscale one, and remembers it, with the window's size and place and the thread you closed it on.
- Links to other sites open in the browser.
- When the server doesn't answer, it shows a page that checks again every two seconds and goes back to where you were once it does. That page also lets you switch to another server.
- While the window is in the background, a thread that finishes or waits for you shows a notification; clicking it opens the thread. On Windows these are the notification area's toasts.
- Right-click a thread in the sidebar, or a message, for a real menu: Rename, Fork, Archive; Quote, Copy. The menus are the client's (apps/client/desktop.js), so a browser keeps its own.
- On plain http over Tailscale, where the page gets no clipboard, copying goes through the app.
- It updates itself: 10 seconds after launch and every hour, it checks this repo's `desktop-v*` releases and shows the update window when there's a newer one.

Changes to ade itself need none of this: the window loads the client from the server, and the page offers "Update" in the list's foot when ade changed. A new desktop release is only for changes in this folder.

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

`dist/` is ignored. Windows installers also need NSIS (`sudo dnf install mingw32-nsis`).

## Release a new version

1. Add a section to the top of `CHANGELOG.md`, `## 0.1.2` with a few lines under it. Its version is the app's version, and its lines are the notes the update window shows.
2. From the repo, in WSL, run `pnpm desktop:release`.

That builds Windows and Linux, signs the updates, uploads them to the GitHub release `desktop-v0.1.2` and publishes it without making it the repo's latest release. Installed apps find it within the hour, or 10 seconds after they next start. It needs `gh` signed in to oskarrough/ade, and the update key.

## The update key

Releases are signed with a key pair. The public half is in `mygo.config.ts`; the secret half is at

```
~/.config/mygo/update-keys/mygo-update.key   (WSL, Oskar's machine)
```

and belongs in the password manager too. Installed apps take only updates signed with it: losing it strands every install on its version, and anyone who has it can ship code to them. On another machine, put it back at that path, or point `MYGO_UPDATER_KEY_FILE` at it, or pass its contents in `MYGO_UPDATER_PRIVATE_KEY`. Never commit it.

## Unsigned, for now

The apps aren't code-signed.

- Windows: running a downloaded installer, SmartScreen says "Windows protected your PC" with "Unknown publisher". Click "More info", then "Run anyway". Updates the app installs itself don't ask again.
- macOS (not built by the release yet): an app from another Mac is signed ad hoc, and Gatekeeper refuses it: "Apple could not verify "arbe desktop" is free of malware". Open it once from System Settings › Privacy & Security › Open Anyway. Signing and notarizing take an Apple Developer ID.
- Linux asks nothing.

## Later: releases from GitHub Actions

mygo's workflow, for when releases should build on push instead of from WSL. It would go in `.github/workflows/desktop-release.yml`, with the update key added first: `gh secret set MYGO_UPDATER_PRIVATE_KEY < ~/.config/mygo/update-keys/mygo-update.key`. It still drafts the release, so publish it with `--latest=false`.

```yaml
name: Desktop release
on:
  push:
    tags: ['desktop-v*']
permissions:
  contents: write
jobs:
  draft-release:
    runs-on: ubuntu-latest
    steps:
      - env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" > /dev/null 2>&1 ||
            gh release create "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" --draft --verify-tag --title "$GITHUB_REF_NAME"
  build:
    needs: draft-release
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-latest, platform: 'darwin/arm64,darwin/amd64' }
          - { os: ubuntu-latest, platform: 'windows/amd64,linux/amd64' }
    defaults:
      run:
        working-directory: apps/desktop
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-go@v7
        with:
          go-version-file: apps/desktop/go.mod
      - if: runner.os == 'Linux'
        run: sudo apt-get update && sudo apt-get install -y nsis
      - env:
          GH_TOKEN: ${{ github.token }}
          MYGO_UPDATER_PRIVATE_KEY: ${{ secrets.MYGO_UPDATER_PRIVATE_KEY }}
        run: go tool mygo build -platform "${{ matrix.platform }}" -upload
```
