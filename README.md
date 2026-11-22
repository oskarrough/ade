# ade

Ade is a chat app for working with agents. Threads live on a server you own, and agents run on the machines you want, in folders you choose.

## Get it

Download arbe desktop, the app:

- [Windows](https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-windows.exe). The app alone joins someone else's server; to run your own, you need WSL, where the app starts it for you.
- [macOS](https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-mac.dmg)
- [Linux](https://github.com/oskarrough/ade/releases/latest/download/arbe-desktop-linux.tar.gz), or `curl -fsSL https://github.com/oskarrough/ade/releases/latest/download/install.sh | sh`

They aren't code-signed yet, so Windows and macOS warn the first time; [the app's README](apps/desktop/README.md#unsigned-for-now) says how past it.

Or run the server and use your browser. You need Node 24 or newer, git, and [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) logged in to a model provider: `npm i -g @earendil-works/pi-coding-agent`, run `pi`, then `/login`. Then, in the folder you want agents to work in:

```sh
npx github:oskarrough/ade
```

Open the address it prints. Your machine is already connected as a runner, so agents can work there right away. To update, stop it and run the same line again.

## Connect a runner

A runner lends a machine's folders and model logins to your server. To let agents work on your laptop too, open Runners at the foot of the thread list, name it and click Add runner. You get one line to run on the laptop, in the folder agents should start in. Keep it private: it holds the runner's key.

Every runner shows up in the model picker, so `sonnet@laptop` is Sonnet working on the laptop.

## The first thread

Click New thread, pick a model and runner below the composer, and write what you want done. The agent works in that runner's folder, and you watch it read, run and edit as it goes. Change the model or runner mid-thread and it keeps the conversation.

From there: [running the server](docs/server.md) for other devices, friends, settings and where your data lives; [modules](docs/modules.md) for bots, scheduled tasks, search and the rest; [the API and CLI](docs/api.md) to script it.
