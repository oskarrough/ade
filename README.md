# ade

Ade is a program for working with agents.

You get bots, multi-user durable threads, scheduled tasks aka workflows. Cross-thread communication feels natural, and bots know how to orchestrate and delegate efficiently.

Use your Anthropic, ChatGPT or Antigravity subscriptions, or really any model that works in `pi`.

Threads live on a server you own, and agents run on the machines you want. Works great for yourself in your own, private Tailscale.

There are two ways to run it: download an run the desktop app (easy), or run `npx --allow-git=all github:oskarrough/ade`.

## Get the desktop app

Download arbe desktop:

- [Linux](https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-linux.tar.gz), or `curl -fsSL https://github.com/oskarrough/ade/releases/latest/download/install.sh | sh`
- [macOS](https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-mac.dmg)
- [Windows](https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-windows.exe). The app alone joins someone else's server; to run your own, you need WSL, where the app starts it for you.

They aren't code-signed yet, so Windows and macOS warn the first time; [the app's README](apps/desktop/README.md#unsigned-for-now) says how past it.

## Browser usage

Run `npx --allow-git=all github:oskarrough/ade` and open the URL it prints. Since npm 12, npx refuses packages from GitHub without that flag; `pnpx` and `bunx` don't need it.

It starts the server and connects a runner, so agents can work immediately.

You need Node 24 or newer and [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) logged in to at least one model provider: `npm i -g @earendil-works/pi-coding-agent`, run `pi`, then `/login`.

## Connect a runner

Ade can let agents work on any device. It works by creating a "runner" on that machine. A runner lends a machine's folders and model logins to your server. To let agents work on your laptop too, open "Runners" and follow the command. You get one, private line run on the laptop.

Every runner shows up in the model picker, so `sonnet:low@laptop` is Sonnet working on the laptop.

## The first thread

Click New thread, pick a model and runner below the composer, and write what you want done. The agent works in that runner's folder, and you watch it read, run and edit as it goes. Change the model or runner mid-thread and it keeps the conversation. Tell it to spawn other threads, any model combination. Instruct them to communicate with each other, if you want.

From there: [running the server](docs/server.md) for other devices, friends, settings and where your data lives; [modules](docs/modules.md) for bots, scheduled tasks, search and the rest; [the API and CLI](docs/api.md) to script it.

## Claude Code and Antigravity in pi

API keys work out of the box (Anthropic, OpenRouter and so on), and so does a ChatGPT subscription. A Claude subscription and Antigravity each need their extension, the ones below.

```sh
pi install https://github.com/earendil-works/pi-claude-code
pi install npm:pi-antigravity
```

## Known gaps

- A scheduled task's check (`check`, on by default) calls `post`, `done` and `keep` through Code Mode's `globals`, which pi-durable marks internal. examples/61 pins them: if a pi-durable upgrade breaks them, `pnpm examples` fails there instead of checks going quiet.
