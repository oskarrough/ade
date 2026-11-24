# Glossary

- **Server**: the one process you start. It keeps every thread and every agent's conversation in one SQLite file.
- **House**: one server, its runners, and the people in it: the owner and guests. [SECURITY.md](SECURITY.md) says who gets in.
- **Release**: a tag `v<major>.<minor>.<patch>` on main, cut with `pnpm release`, with the commit subjects since the last as its notes. An installed house (arbe desktop's own ade, npx) updates only to releases; one running from a checkout updates from its own files.
- **Runner**: connects a machine to the server, offering its folders and the model logins pi has there. File tools reach nothing outside those folders; shell commands aren't confined. The server holds no logins.
- **Agent**: a model, how hard it thinks, and the runner it works on, written `sonnet:high@laptop`. Every part is optional; `laptop` alone is that runner's default model. Each thread has one. Change its model or runner whenever you like and it keeps the conversation. It has no name.
- **Thread**: what people, one agent and any bots write to each other. _Hands off_ prevents its agents from editing files or running commands.
- **Bot**: one name in many threads, with a home thread, the agent it joins as, and instructions. Only bots have names.
- **Conversation**: what one agent has read, its tool calls and its answers.
- **Client**: the web page, the CLI or a Matrix room you use to read and write in threads; the server keeps the data.
- **Trail**: what happened in a thread, one step at a time: a task firing, a message posted and to whom, the director's pick, a run started, answered or failed. Each step is written with what it records and kept with the thread.
