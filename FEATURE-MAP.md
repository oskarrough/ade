# Feature map

Where things live, so you open the right file first. The README says what each thing is; this says where it is.

```
bin.js                   the `ade` executable: server, CLI commands or runner
server.js                the server: Pi Durable store, tasks, HTTP API, /ws, runners, settings
  Thread, Runners, Keys, Receipts   its docs (defineDoc); sessionDoc, shared session defaults
  Anchor, Admit, Deliver, Shell     tasks: own an agent, take a message in, hand it over, run `$ cmd`
  person                            whether a person wrote a message
  address, whom, modelOn, reach     whom a `to` asks, on which runner and model
  recipients, invited               who a message asks; bots it @mentions that aren't in the thread yet
  post, append, postEntry           write a message and hand it to each agent it asks; setPaused
  ask, route, ROUTE, routed, fresh  whom a message asks; the director's saved pick
  TRAIL, trailed, trail, nameIn, ranAs   a thread's trail, in a conversation of its own: each step written in its commit, GET /api/threads/:id/trail, `trail/<id>`
  messages, firstWrote, authors   a thread's messages, or only the newest, the ones since one or a time, or those that match, read back from its end; when each person first wrote
  Draft, saveDraft, draftIn, NEW, spentUnder   a person's unsent draft per thread, and for a new one; `draft/<id>` feed view
  createThread, written, mayAsk     a thread and its first message in one commit
  withdraw, WITHDRAWAL              a message taken back before any agent read it
  afterCommit                       best-effort work after a commit
  isWork, busy, workIn              whether a thread has work
  createFeed, feed                  one versioned `/ws` feed (`seq`, `define`, `onCommit`, `touch`, `subscribe`, `sync`)
  shapeMessages, families, familyField   per-viewer message shaping (`speaker`, `showName`, `voice`, `to`, `other*`) and open families
  core.*                            what modules call: trailed, conversations, feed, snapshot, spent, task, tasks, signal, threadRows, threadMatch
  entryStored, documentStored, endedHooks, runnerHooks, withdrawn   modules' hooks of the same names (`ended` for endedHooks, `runner` for runnerHooks, `uninvited` for uninvitedHooks)
  committed                         modules' hook of that name: each commit Pi stored, whole, with its seq
  reconfigure, newAgent, setUp      an agent starting, or switching model/thinking/runner/folder in place
  outcome, tell, restore, faulted   what a finished or failed delivery posts back
  shown                             images an answer shows as `![](path)`, read through its runner and attached
  reachable                         a message waits for its agent's runner
  moveAgent, keysOf                 move an agent to another runner (POST /api/threads/:id/move)
  finishShell                       a shell's output and outcome, committed together
  gone                              an agent whose folder no longer exists
  work, status, busiest, agentsIn   working / blocked / idle for agents, threads, runners
  threadIds, threadList, threadRows, threadRow, threadPage, threadView, people, newest   GET /api/threads and a thread's view, which `thread/<id>` shares
  listFacts, placedTo               what a whole list reads of messages and agents, from the `ade_` tables while they're current
  loadEntries                       the shared entry cache
  recent, older, back, conversationRecord   each thread's newest entries, older ones on demand
  anyRunner, mayRun                 `bash` with a `runner`, and the `runners` tool
  harnessSettings, provide          Pi's settings; a runner's models as Pi's provider
  forkThread, seenBy, unseenAt      forks
  compact, compactingAt             compaction
  setTitle, setTitleIn, setTools, toolList, toolsOf   a thread's title and tools
  receipt, once                     a retried request does its work once
  whoSent, keyIn, answersTo, owner  who sent a request: owner key, invite key, Tailscale login, listeners (SERVE_PORT, HOOK_PORT); the rules are SECURITY.md
  Invites, invite, uninvite, guests, closeSockets   invites (`invites` in ade.json): keys with names, GET/POST/DELETE /api/invites; POST /api/link, the owner link; keepKey, the key cookie; cli.js `invite`, `uninvite`, `invites`
  newKey                            a new runner or invite key; a request key derives it, so a retry gets it again
  fromAgent, agentPeer              an agent's command on this machine (runner.js sets ADE_AGENT_OF) writes nothing
  exampleShed                       the walkthrough's example thread (POST /api/threads/shed)
  routes                            every HTTP route
  agents/, agentRows, agentRow, liveOf, followLive, cutOf, covers   `agents/<id>` feed view: a thread's agents' turns, cuts and live work
  mintKey, revoke, Makers, upgrade  runner keys, who made a guest's runner, and sockets; a module's `connect` socket
  saveSettings, restartSoon, restart, connectSelf   settings, restart (POST /api/restart), the server's own machine as a runner
  stale                             whether the server's code changed since it started
echo.js                  echo/try scripted model responses
runner.js                a runner: offers models and folders, runs agents on its machine
runner-updater.js        what `curl <server>/connect-runner | sh` starts; keeps the runner up to date
read.js                  the `ade_` tables, the house as SQL in ade's database: SCHEMA, projector (one function per kind of
                         Pi record, apply, know), snapshot (Pi's records at one commit), recordsOf, fill; keep, the worker
                         that writes them (resume, make, apply on a beat, closed, settle, fail, check with againstRebuild
                         and FACTS); createRead: exact for the list, recent for search (core.recent), flush, serve (GET /api/read, ?check, POST {rebuild})
remote.js                the runner protocol: createRunners (server), serveRunner (runner), runnerProvider, remoteEnv
cli.js                   the API from a terminal; `link`, the owner's browser link
util.js                  shared helpers: personName, agentTo, writtenTo, smallModel, mentioned, keyOf, speaker, said,
                         written, byAgent, finished, background, collect, firstIn, complete (module model calls), stepText
modules.js               builtIn, dataDir, ade.json, MODULES; loads each module's server and runner half
modules/
  talk.js                `post` and `threads` tools; resolveThread, reply, member
  auto-title.js          AutoTitle, sanitizeThreadTitle; serve
  memory.js              memory lines (Line task), `zoom`, writerOf, demand, beforeCompact, inTurn, writeLines,
                         indexOf, messagesAt, checked, remembers, turn, view, opened, views, layOut, render, rendered
  bots.js                bots: their doc, `bot` tool, /api/bots (serve, change, remove, requireBotEditor, botKey, renameIn), askedHome,
                         answeredAt, posted, homesOf, DEFAULT_VOICE, voice, section, bot-threads, volatility, withoutProject
  context.js             AGENTS.md, skills and cwd from the runner; expand, skillCommand
  director.js            the `direct` hook and Pick task: directing, picks, typing, beatOf, typingIn, sent, Nudge,
                         pick, decide, covers, turns, botTurns, section
  mermaid.js             nudges agents toward Mermaid diagrams
  recap.js               a thread's recap: WRITER, Recap doc, Write task, walk, since, start, misshapen, checklist, looking,
                         serve, the `recap` tool
  canvas.js              a tldraw canvas per thread: Canvas doc, rooms, `canvas_look` (look, seen, report, present),
                         `canvas_act` (apply, created, updated), meta.by (authorizeRecord, onCommittedChanges, grew); serve, connect
  inbox.js               `ask_person`, openQuestion, openQuestions (from the `ade_` tables), itemOf, list, the `inbox` feed a thread at a time; serve (GET /api/inbox, dismissals)
  schedule.js            scheduled tasks: `schedule` tool, create, edit, placed, recipientsOf, current, ScheduledTask (asleep, wakeAt, endOf,
                         onward, Control, Hooked, Ended, Happened), run, scheduleOf, startOf, firstRun, settle, happen, already, runner, uninvited,
                         entryStored, pending, taskForChange, cancel, control, checker, checkOf, steps (end, next, onward, post), the `checked` phase; serve
  check.js               a scheduled task's check: CheckRun, Said doc, the `scheduled_check` tool (Code Mode with post, done
                         and keep as globals), outcomeOf, the hook that keeps it from `schedule`
  hooks.js               outside events for scheduled tasks: Hook doc, issue, webhook, admit, PROBES, RATE, github,
                         fact, SHAPES, LIFETIME, GENERATION, stale; serve
  web-search.js          `web_search`
  status.js              Program Status Protocol (OSC 7501) on the runner's terminal: tell and touched (the threads a commit changed), heard
  matrix.js              Matrix rooms as threads (MatrixSend, relay, sync)
  export.js              GET /api/export, sent a message at a time: fileName, markdown, json, file, foldShell; cli.js `export <dir>`
  search.js              search over the read model's FTS5 index of messages (read.js): search, matchOf; serve, the `search` tool
  jump.js                Cmd-K's switch; the client does the rest
  usage.js               tokens and cost: spend, build, entryStored, settle, spent; serve
  pi-sessions.js         threads as pi session files (push, sync, changed, writePiSession) and back (bring);
                         serve, listPiSessions, readPiSession
apps/desktop/            arbe desktop, a Go app on mygo (main.go, preload.js, offline.html, release.sh; README.md there); .github/workflows/desktop-release.yml builds its releases
apps/client/             the web client, Solid 2, no build (README.md there)
  browser-modules.d.ts   type declarations for CDN imports (tldraw, diff)
  client.html            the walkthrough and the app's page; the promises every change serves
  client.js              root: the chat, or the live system around it
  server.js              the server as the client sees it: api, write, the one socket, restart and restarting (reload once it's back), in-memory feed store (`subscribeView` with its `heard`, `feedView`, `feedItem`, `caughtUp`),
                         actions (`archiveThread`, `renameThread`, `dismiss`, `forgetBot`, `revokeRunner`), threadOf, familyOf, current, page, openThread, fork, earlier, loadEarlier, sending, me
  thread.js              one thread on screen
    Thread               `thread/<id>` (shaped messages, people, earlier) and `agents/<id>` (turns, cuts, live work, `?from=` for earlier pages) feeds; follow, onScreen, shownFrom, nearTop, hold
    rows                 server-shaped messages laid out with agent turns, lasting calls, cuts and memory lines
    Asked                in a bot's home, a question another thread asked it (askedHere)
    Message              one message: author, pick, fork link, waiting, Body, Images; `Cross` for one that crossed threads
    Body, threadLink     a message's markdown; thread titles as links
    Images               a message's images; a click opens its thread's Lightbox
    Lightbox             every image in the thread over the page, thumbnails down the side, arrows and swipes between, go to message (`images`, `showRow`)
  run.js                 an agent's turns
    heardAgents, conversations   each agent's entries, cut and live work from `agents/<id>`
    turnsOf, cutOf       turns, and the newest compaction cut
    timesOf              when deliveries went out and entries were written
    summary              a closed turn's one line
    Exchange             an ask's row in the asking thread
    answersIn, answerOf  a post's answer from the thread it asked
    LASTING, lastingOf   tool calls shown as their own rows
    Changed, Fold, wordDiff   a bot rewriting itself, as a word diff
    Turn, Step, Call     a turn, opened into steps
    handedStep, light, litIn   the messages a turn was handed
  time.js                Stamp, Break, breakOf
  composer.js            the box you type in
    pick, agent, askedBots, recipients   whom the next message asks
    mention, pickMention, mentionsFor, MentionRow   @ lists bots and threads
    skills, loadSkills, skillsFor   `/` lists skills
    appendQuote, textareas   quotes from the quote button
    choose, configure, toFor   model picker and runner controls
    changeDraftFor, saveLater, save, wasSent, tookDraft, heardDraft, sendingNow   drafts, heard on `draft/<id>`
    Composer             submit, add, pickRecipients, filled, compactNow, folderOf, where
    PickerBot            bots in the picker
  agent.js               agent labels and live work: doing, agentTo, formatAgent, lastToolCall, liveOf, modelsOf
  model-picker.js        model search, thinking and folder: ModelPicker, matches, fromRunner, metered, Metered
  runner.js              runner list, ConnectRunner; Stranded, runnersWith
  bot.js                 BotSettings, ForgetBot, new bot, botThreads, botMenu, BotCard
  thread-list.js         ThreadList, family rows, Inbox toggle, Update (restart, or arbe desktop's own release), creatingBot, threadMenu,
                         ThreadCard (a row's hover card), GetApp (the desktop download)
  hover-card.js          HoverCard, HoverFrame, cards: one card frame that glides beside the hovered row, fine pointers only
  schedule.js            ScheduledTaskList, TaskRow, ThreadTasks, OfflineRunner, TaskForm (its timeline), openTaskForm,
                         ScheduledTasks, Ring, LastRun, Controls, ScheduledTaskSet, ScheduledRun
  clock.js               when a scheduled task runs, shared with the server: nextRun, runsAfter, lastRun, wall, instant
  search.js              SearchField, Search, Result, marked, showMessage
  jump.js                Jump (Cmd-K), openJump, go
  theme.js               Auto/Light/Dark, chosen from Cmd-K's Choose theme: theme, chooseTheme, openThemeMenu, ThemeMenu
  usage.js               Usage, Mix, Days, ThreadUsage
  inbox.js               Inbox, brief, Question, Failed, Finished, Meta, RecapLine
  thread-details.js      DetailsPage: threads, scheduled, then Settings and Usage folded, for a thread and a bot's home
  pi-sessions.js         PiSessionList, PiSource
  canvas.js              Canvas: load, board, fitLabels, reportSeen; CanvasRow, showOnCanvas
  canvas/agent/          canvas_act's action schema from tldraw's agent starter kit
  canvas/tldraw.js       the one place tldraw's version is named
  recap.js               Recap tab: topicsOf, Topic, Page
  side.js                the side column: pagesOf, sideOf, openSide, toggleSide, PageTabs
  trail.js               Trail tab: `trail/<id>` feed, and whatHappened, a message's story from its right-click menu
  agent-memory.js        memory popover and compaction view
  icons.js               Icon, the stroke icons
  title.js               defaultTitle
  settings.js            server settings, one row per module
  people.js              Settings' People, the owner's: invites on or off, invite links, who holds one, the owner link
  desktop.js             nativeMenu, right-click menus in arbe desktop; clearOfControls, pane headers clear of the window buttons
  system.js, wires.js    the live system diagram and its wires
  tutorial.js            walkthrough buttons
  tutorial-shed.js       loadShed
  tutorial-shed-memory.js   recorded memory lines for the shed
  panes.js, popover.js, sure.js, busy.js, notice.js, dot.js   Panes, placePopover, Sure, Busy, Notice, Dot
  list-keys.js           listKeys: one keyboard for the lists you type above (Cmd-K, @ and /, the model picker)
  quote.js               QuoteButton
  images.js, markdown.js image shrinking; markdown, threadMention
  mermaid.js             messageDiagrams, storyDiagram
  base.css               tokens, reset, every control's look, popover, rows, panes, dot
  app.css                the chat's layout
  walkthrough.css        the story page and live system, under body:not(.chat)
scripts/
  try.js                 scratch server with a real runner, using echo/try; no provider keys reach it
  fuzz.js, fuzz-spec.js  `pnpm fuzz`: Bombadil against a fresh try.js, its one-screen failure story, replay, repeat and per-machine lock, and the properties it holds the client to
  fuzz-crash.js          `pnpm fuzz --crash`: kills a busy scratch server 100 times and checks a crash loses nothing
  page-spy.js            browser init script: fetches, socket frames, stalls
  solid-attribution.js   browser init script: Solid's cost warnings and costs()
  vendor-canvas-agent.js refreshes canvas_act's schema
  replay-pi.js           replays pi sessions into a thread
examples/all.js          the suite runner
examples/lib.js          shared: start, command, kill, server, runner, scriptedRunner, api, createThread, postEntry,
                         view, until, quiet, settled, online, executing, check
examples/NN-*.js         one user promise each
examples/*-real-model.js the bench, REAL=1 only (real-model-bench.js, real-model-bench.md)
```

Where a feature lives:

- Talk between threads: modules/talk.js, server.js append/whom, thread.js `Cross`, run.js `Exchange`.
- Models: composer.js pick/choose, model-picker.js, server.js whom/reconfigure.
- Live work: server.js work/liveOf/`agents/`, agent.js doing, run.js heardAgents and Turn.
- Recaps: modules/recap.js, client recap.js, side.js.
- Canvas: modules/canvas.js, client canvas.js, server.js upgrade, side.js.
- Memory and compaction: modules/memory.js, server.js compact, agent-memory.js, thread.js rows, run.js cutOf.
- Bots: modules/bots.js, bot.js, composer.js PickerBot, client server.js homeBot/botAgent/colorOf, settings.js.
- Runners and keys: remote.js, runner.js, server.js mintKey/revoke/upgrade, client runner.js.
- Forks: server.js forkThread, client server.js fork, thread.js Message (forked →) and Thread (forked from).
- `$ cmd`: server.js Shell, printed, shells.
- Status dots and questions: server.js status/busiest/concerns (a failure is red and an answer blue only to who wrote in the thread, as the inbox lists it), dot.js, modules/inbox.js openQuestion.
- Inbox: modules/inbox.js, client inbox.js, server.js inbox/dismiss/page, thread-list.js.
- Pi session files: modules/pi-sessions.js, remote.js serveRunner and RUNNER_FILES, cli.js `import`.
- Scheduled tasks: modules/schedule.js, modules/hooks.js, modules/check.js, util.js said, client schedule.js and clock.js, time.js `ahead`.
- Settings and modules: modules.js, server.js saveSettings/restart, settings.js.
- Threads side by side: client server.js followThread/besideKey/openBeside, `columns`.
- Right-click menus: desktop.js nativeMenu, thread-list.js threadMenu, thread.js messageMenu, bot.js botMenu.
- What happened in a thread: server.js trailed (writes, in each step's commit) and trail (reads), util.js stepText, cli.js `trail`, client trail.js. What changes about a thread, a bot or a scheduled task is a step written where it changes: startThread, setTitleIn, archiveIn, setPaused, setTools, setUp, reconfigure, forkThread, bots.js write and remove, schedule.js make, fire and abort.
- The house as SQL: read.js, server.js `read`, `committed`, listFacts and the stop's flush, docs/server.md.
- A page behind its ade: server.js hashOf/clientVersion, GET /api/changes, client server.js `behind` (reloads by itself when hidden or idle)/`changes`, thread-list.js `Update`; up to date, its `Version` line and the newest twenty commits, or an installed house's release notes.
- Releases: scripts/release.sh (`pnpm release`) tags main `v*` with the subjects since the last, signed with the desktop update key (house.sh digest); server.js readRelease/takeStaged (`.release`, `<folder>.next` swapped in on restart); desktop.js shellUpdate, main.go ShellUpdate/InstallUpdate.
- The desktop app's house: apps/desktop house.go (house.json, startHouse when the local server doesn't answer, the House menu), house.sh (start, stop and status of only the house it started, in WSL on Windows; the log; without ade installed, its own ade and Node, the newest release, fetched on first start, and newer ones staged hourly in ade.next by updateHouse, only when signed (verify) and new enough for this app (too_old; house.go tooOld says so); a release that doesn't come up goes back to ade.old (run); login, pi in a terminal for Desktop.Login, which the model picker's LogIn in apps/client/runner.js calls; key, the owner key ownerKey puts in the window's cookie).
- The desktop window: apps/desktop main.go (`Desktop.Menu`), preload.js; releases: release.sh tags, .github/workflows/desktop-release.yml builds and publishes.

## UI parts

Build from these; a new panel, row or button takes its sibling's markup and class and adds no CSS of its own. A control gets its look only in base.css; a rule for a place sets layout only. Quoted names are the CSS files' section comments.

- Buttons ("Three buttons"): plain `button` (bordered), `button.ghost`, `button.primary`; `data-danger`, `.small`; `.send` and `.row` look their own. Fields: `input`, `textarea`, `select`, `.bare`, `.draft`.
- Popover: `div.popover[popover]` placed by `placePopover` (popover.js), a sheet on phones; panes.js `Panes` (`.panes .pane`, "A detail covers") gives header, back, actions and `foot`. Used by settings, runners, context; the model picker and @mentions are the frame without panes.
- Popover rows: `ul.rows > li` ("One row across").
- Model controls: model-picker.js `ModelPicker`, `.model-controls`: `.search`, `.list`, `.models`, `.foot`, `.thinking`. Cmd-K, the @ and / list and the model picker share one `.list` and one keyboard, list-keys.js `listKeys`.
- Left aside: thread-list.js `ThreadList`, `.thread-list`, `ul.top-row`, `ul.inbox-row`, `li > .row`, `.thread-family`, `.list-foot`, `.foot-toggle`.
- Side column: `aside.side`, side.js `PageTabs`; `.thread-details`, `.recap`, `.canvas`, `.director`; bot.js `BotSettings`, `.bot`.
- Thread head: `h2.title > button.ghost.thread-name`, `.close`, the phone's `.app-bar` (its back is server.js `backToList`: a thread opened from the phone's list is a history entry, popstate brings the list back); `.page-head` on list pages.
- Message list: thread.js `Message` in `.thread > ul > li`, `.markdown`, `div.images`, `dialog.lightbox`, `li.cut`, `li.line`.
- Quoting: quote.js, composer.js `appendQuote`, app.css `.quote-anchor`/`.quote`.
- Tool calls: run.js `Turn`, `Exchange`, `Step`, `Call`; `li.turn`, `.steps`, `.tool`, `.said`, `.exchange`, `li.sent`, `li.received`.
- Composer: composer.js `Composer`, `.thread form`, `.bar`, `.icon`, `.pick`, `.stop`, `ul.images`.
- Small parts: sure.js `Sure`, busy.js `Busy`, notice.js `Notice`, dot.js `Dot`.
