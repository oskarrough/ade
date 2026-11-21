# Feature map

Where things live, so you open the right file first. The README says what each thing is; this says where it is.

```
bin.js                   installed executable `ade`: dispatches to server, CLI commands, or runner
server.js                the server: Pi Durable store, tasks, HTTP API, /ws, runners, settings
  Thread, Runners, Keys, Receipts   the docs it keeps (defineDoc)
  Anchor, Admit, Deliver, Shell     the tasks: own an agent, take a message in, hand it over, run `$ cmd`
  person                            whether a person wrote a message; Admit hands one person's as typed, and tags them once a second writes
  address, whom, modelOn, reach     whom a `to` asks, on which runner and model
  recipients                       director → explicit recipient → thread agent in groups / last-asked in solo chats and commands
  invited                          the bots a message @mentions that aren't in the thread yet, which it asks too
  post, append, postEntry           write a message and hand it to each agent it asks; setPaused: Pause, only @mentions and named recipients; `direct` leaves that to the director's Pick task
  ask, route, ROUTE, routed         Admit/Deliver for whom a message asks; the director's pick saved after its message, read as its `to`/`picked`;
                                    `fresh`: a message that takes over its author's pending pick
  withdraw, WITHDRAWAL              a message taken back by its author before any agent read it: out of `unseen` and the
                                    agents' inboxes in one commit, a withdrawal entry routed reads as `withdrawn`;
                                    modules' `withdrawn(tx, thread, message)` hook (memory rewrites its line)
  core.activity                     short-lived `{thread, activity}` socket events a module sends while it works (the Director tab)
  afterCommit                       best-effort work once a server commit is stored
  isWork, busy, workIn              what counts as a thread working (Deliver, Shell, modules' `work` kinds); whether a thread has
                                    work (a view's `busy`, CLI waits, wake); listsOf hears its last one end, which calls
                                    modules' `ended(threadId)`; every task change, modules' `taskChanged(record)`
  core.task, core.tasks             a task's record, or every task matching a Pi TaskQuery (wake lists a thread's sleeping ones)
  core.signal                       a signal to a sleeping task (wake's Ended)
  reconfigure, newAgent, setUp      an agent switching model/thinking/runner/folder in place, or starting
  outcome, tell, restore, faulted   what a finished delivery posts back (a bot's answer asks whom direct says), or a failure says
  reachable                         a message waits for its agent's runner, following the agent if it moves
  gone                              an agent's folder that no longer exists: it doesn't run, the thread says so
  work, status, busiest, agentsIn   working / blocked / idle for agents, threads, runners
  threadList, threadRow, threadView, people   what GET /api/threads returns; people kept per thread (writers), read once;
                                    newest, a thread's messages read back from its end (?last, ?after)
  recent, older, back, conversationRecord   each thread's newest entries and record kept as commits land, its older ones read
                                    once; `back` looks newest first through both, for status and latestMessage (openQuestion)
  anyRunner, mayRun                 `bash` with an optional `runner`, and the `runners` tool listing whom an agent may run commands on
  harnessSettings, provide          Pi's settings, worked out once per change of models (provide, a runner's models as Pi's provider)
  listsOf, placed, listOf, recheck  which lists a commit moves: a thread's own list; the inbox when a thread's open question
                                    comes or goes (recheck, over openQuestion) or is dismissed
  forkThread, seenBy                forks
  compact, compactingAt             compaction now, or early
  setTitle, setTitleIn, setTools, toolList, toolsOf   a thread's title and tools
  receipt, once                     a retried request does its work once
  whoSent, answersTo, owner         owner: ade.json's `owner`, else the login here (ownerName), and `ownerLogins`, tailnet logins that are the owner (loginList); who sent a request or socket, from how it arrived: the owner key (owner.key beside the store,
                                    a bearer or the cookie POST /api/me sets), a direct request on the main listener (the owner),
                                    or Tailscale-User-Login on Serve's listener (SERVE_PORT, listener(true)); Host and Origin checks
  exampleShed                       the walkthrough's example thread, written as its three people (POST /api/threads/shed)
  routes                            every HTTP route, as the README lists them
  watch, rewatch, told, doing       /ws: a browser watching one thread and its agents' live work, its newest FIRST messages first
  cutOf                             an agent's newest compaction cut, sent with its first batch so its turns reach back only to the messages sent
  earlier, covers                   an earlier page on request, after the agent turns that reach back to it
  mintKey, revoke, upgrade          runner keys and the runner's socket; a module's own thread socket (its `connect`)
  saveSettings, restart, connectSelf   settings, restart, the server lending its own machine, under the name it first got
echo.js                  echo/try scripted model responses: file tools, slow commands, posts, `ask` questions, `wake` calls, bots, director and recap
runner.js                a runner: offers its models and folder shortcuts, connects, runs agents in any folder on its machine
runner-updater.js        what `curl <server>/connect-runner | sh` starts (it saves the key in ~/.config/ade/key.<name>); keeps the runner up to date
remote.js                the runner protocol, both ends: createRunners (server), serveRunner (runner),
                         runnerProvider (a model over the wire), remoteEnv (tools in the runner's folder)
cli.js                   the API from a terminal; the owner key as a bearer off localhost (ADE_OWNER_KEY); `link`, the owner's browser link
util.js                  helpers server and modules share: personName (`~login`, `@` as `+`), agentTo, writtenTo, smallModel (Haiku/Luna if the runner lists it, else the agent's own), mentioned, keyOf, speaker, said, written, byAgent,
                         finished (task result), background (thread-owned task), collect and firstIn (every item of a paged scan, or the first match), complete (module model calls, optional Pi retries)
modules.js               builtIn (each module's own `on` default), dataDir ($XDG_DATA_HOME/ade, default ~/.local/share/ade), ade.json ($XDG_CONFIG_HOME/ade, default ~/.config/ade), MODULES, and loading each module's server/runner half
modules/
  talk.js                `post` and `threads` tools; resolveThread accepts ids as numbers or digit strings, or exact, unambiguous titles; post defaults missing titles from the body; reply sends answers back to the parent thread that asked; a bot in the
                         thread it posts to speaks there as itself (member), and so does a bot that
                         starts a thread for two or more bots (opener in server.js's post)
  auto-title.js          first-answer title generation (AutoTitle; the model sees the opening and the newest messages, `recent`), sanitizeThreadTitle, one attempt per thread; serve: a new title on request
  memory.js              memory lines (Line task), `zoom`, `writerOf` (util's smallModel with low thinking), short messages verbatim on arrival, long ones and merges only on demand (`demand`: memory view and 70% of compactAt write message lines, `beforeCompact` the cut's merges), per-thread batch queue with compaction first (`inTurn`, `writeLines`, up to 16), incremental message/line index (`indexOf`, a fork's parent's lines included), short-only startup backfill, catch-up and compaction cut, each thread's switch (remembers, turn), recorded-line import (serve), the memory view in one read (view, opened), laid out once per change (views, layOut); render; indexOf, memory and rendered, which recap reads too
  bots.js                bots: their doc, `bot` tool, /api/bots (serve, change, remove, a rename through server.js renameIn),
                         the threads that asked a home, in one read (askedHome, `?asked=`),
                         each with `answeredAt`, stamped on the bot's doc by posted when its entry carries an answer;
                         homesOf, which server.js threadRow uses to title a home with its bot's name; a new bot starts
                         with empty instructions, hers to write with the `bot` tool; DEFAULT_VOICE and `voice`, the
                         shared instruction every bot's prompt carries just before its own (section), editable as
                         `bots.voice` in ade.json through settings (settings: {voice}, server.js's saveSettings)
  context.js             AGENTS.md, skills and the folder's path (cwd) from the runner;
                         a folder's skills by name (serve), a person's /skill:name expanded as pi does (expand, skillCommand)
  director.js            the `direct` hook: @mentions ask that bot; a free message in a group, or with one agent and two people
                         writing (core.authors), is saved with a Pick task (`directing`), one pending per author (Thread `picks`);
                         Pick's wait phase sleeps the burst then holds while anyone types (typing, beatOf, typingIn, sent, Nudge signal),
                         its call phase picks one candidate or nobody with a confidence (pick, decide: Jev with TYPESAFE_API_KEY,
                         else the chooser model's JSON); the author's next message supersedes it (covers); a paused thread skips it;
                         activity events for the Director tab; settings model, context, timeout, burst
                         those asked take turns (`turns`); a bot's answer @mentioning a bot asks it, resting
                         after three bot answers in a row (botTurns); tells bots to @mention, not post (section)
  recap.js               a thread's recap, a checklist of `- [x]`/`- [ ]` lines: WRITER (the prompt), Recap doc, Write task (one writer,
                         rounds while more is new), since (the new messages, numbered), misshapen (one retry), checklist (the cap), looking (who has it open),
                         serve, the `recap` tool; off by default
  canvas.js              a tldraw canvas per thread: Canvas doc (the room's snapshot; a fork copies it), rooms (one TLSocketRoom per
                         thread in use, saved shortly after edits, closed when empty),
                         `canvas_look` (look: the stored shapes, read, and what each person present has selected and in view, as
                         their tab reports it: seen, report, present) and `canvas_act` (alone: create, update, delete, move and
                         label on the stored shapes: apply, created, updated, sizes guessed); who drew it (`meta.by`, the session's user, stamped by
                         authorizeRecord and onCommittedChanges, except a shape that only grew to fit its label: grew);
                         serve (GET shapes, POST actions/look), connect; off by default
  blocked.js             `ask_person` posts an explicitly marked question; openQuestion reads the latest relevant message via server.js latestMessage: the question, unless a person has replied, used by server.js status and core.openQuestion; off by default
  inbox.js               every thread's open question, newest first (questions, over core.openQuestion), serve (GET /api/inbox,
                         POST a dismissal, kept as the Thread doc's `dismissed`); off by default
  wake.js                `wake`: an agent's note posted back to it later (Wake, a background stored sleep owned by the thread, `every`
                         sleeps again), or once thread `after` has no work left (Ended signal; settle, run on start and on the
                         server's `ended`, over core.busy), taskChanged tells the thread's pages (`wake` activity), pending (the thread's sleeping wakes), cancel, serve (GET/POST /api/threads/:id/wake),
                         archiving cancels them; duration parses 5m, 1h30m; off by default
  web-search.js          `web_search`
  status.js              Program Status Protocol (OSC 7501) on the runner's terminal
  matrix.js              Matrix rooms as threads (MatrixSend, relay, sync)
  export.js              GET /api/export (serve) answers {files}, every thread's files, archived ones included, as
                         a map of name to text, one Markdown file and one JSON file each, nothing written on the
                         server (fileName, util's byAgent, toMarkdown, foldShell folding a
                         `$ cmd`'s output to one line); off by default; cli.js's `export <dir>` fetches it and
                         writes the files
  pi-sessions.js         conversations as pi session files: server follows each agent's conversation (push, sync, changed) and sends
                         new entries; writePiSession, the runner's `pi-session` op (remote.js serveRunner), maps them to pi's entries.
                         The other way: bring (what pi hands its model from a session, into a new thread: newAgent, setUp, post), serve
                         (`/api/pi-sessions`), listPiSessions and readPiSession (the runner's `pi-session-list` and `-read`, over pi's own projection and convertToLlm)
apps/desktop/            arbe desktop: ade's page in its own window, a Go app on mygo (main.go, preload.js, offline.html; README.md there)
apps/client/             the web client, Solid 2, no build (README.md there)
  browser-modules.d.ts   checker declarations for browser-only CDN imports (tldraw, diff)
  client.html            the walkthrough and the app's page; the promises every change serves
  client.js              root: just the chat, or the live system around it
  server.js              the server as the client sees it: api, watch, lists (threads, runners, bots, inbox), fetched once the socket opens; withFamilies, each thread's family from parent and forks,
                         threadOf, current, openThread, fork, entries store, earlier and loadEarlier (the page before, or all)
                         optimistically: archive, rename, dismiss, forget a bot and revoke a runner show at once, put the row back if the server refuses
                         (changeThread; removable, a list whose rows you can take away)
                         me, who the server takes this page for (GET /api/server's `me`), only to mark your messages; a `#key=` link
                         trades the owner key for a cookie (POST /api/me) and leaves the address
  thread.js              one thread on screen
    Thread               subscribes to the thread over /ws, keeps its messages, follows the bottom (follow), lays out only its
                         newest SHOWN rows (onScreen, shownFrom) and the rows above, then the page before, near the top (nearTop),
                         holding the view still as they land (hold)
    rows                 projection: messages plus each agent's turns, a row for each lasting call (an ask, a bot change),
                         live turn, compaction cuts, folded memory lines
    Asked                in a bot's home, a question another thread asked it, a received `Cross` row; the bot's answer follows as its own Message (askedHere)
    Message              one message: author, the director's pick, fork link (× instead while yours waits for a working agent, `waiting`), Body, Images; one that crossed threads is a `Cross` step row;
                         an answer to someone further up says whom (replyTo in rows); a Stop is one grey line naming who pressed it
    Body, threadLink     a message's markdown; a thread it mentions by title is a link that opens it
  run.js                 an agent's turns, from its own conversation
    heard, conversations the conversation entries the socket brings
    turnsOf, cutOf       a conversation cut into turns, and where its newest compaction cut it, as the socket's `cut` says (compactions)
    timesOf              when its deliveries went out and its entries were written: dates messages from before createdAt
    summary              a closed turn's one line ("edited 2 files · 1 command")
    Exchange             an ask's own row in the asking thread: a sent `Cross` row, then the answer as a received one
    answersIn, answerOf  a post step's answer from the thread it asked
    LASTING, lastingOf   the tool calls that change something beyond the run, each its own row: posts that ask, `bot` rewrites,
                         canvas_act (canvas.js CanvasRow), wake (wake.js WakeSet)
    Changed              a bot rewriting itself: ✎, its name, what changed; opened, a word diff of old against new (the call's details.before; jsdiff from esm.sh on first open, wordDiff), unchanged stretches folded into ⋯ (Fold)
    Turn, Step, Call     a turn's line, opened into steps
    handedStep, light, litIn   the handed step as a count (none for the one message above); opened, it lights those messages
  time.js                when things were said: Stamp, a row's time under it on hover (now, 4m, 2h, else 14:32; one minute clock);
                         Break, the line where a day changes or an hour passed between two messages (breakOf)
  composer.js            the box you type in
    pick, agent, askedBots, recipients   whom the next message asks, per thread
    mention, pickMention, mentionsFor   typing @ lists bots, then threads by any word of their title (a combobox); picking a bot asks it,
                         which is how it joins; picking a thread writes `@"its title"`, no more
    MentionRow           an option in that list, bot, thread or skill; each option says what it writes
    skills, loadSkills, skillsFor   `/` opening a message lists the skills where its agent works; picking one writes `/skill:name `
    appendQuote, textareas   a message's quote button sends its selection here: `> ` on every line, a block
                         below anything already there, a blank line and the cursor after it
    choose, configure, toFor             model picker and runner controls changing that pick
    Composer: submit, add, pickRecipients, filled, compactNow   send, images, typed recipients, context meter;
    folderOf, where                                          the folder the next message's agent works in, said on its button
    PickerBot            bots in the picker
  agent.js               agents' labels and live work (doing); client's agentTo, formatAgent, lastToolCall, modelsOf
  model-picker.js        model search, thinking and folder controls (composer and settings share them); matches;
                         metered and Metered, the $ on a model billed per token (the runner's `metered` providers, less its `free` models)
  runner.js              runner list, a runner's agents, ConnectRunner
  bot.js                 a bot's settings, its threads row, new bot; botThreads shares its own/elsewhere lists
  thread-list.js         the thread list, its family rows, the Blocked filter (including children and bot homes), or with inbox on, the Inbox toggle
  wake.js                Wakes, the thread's pending wakes above the composer as one-line `.notice` lines (`.line`, open on click) with × (refetched on connect and on
                         each `wake` activity its socket hears, heardWake);
                         WakeSet, a wake call's row in the chat (run.js LASTING); WokeLine under a message a wake posted
  inbox.js               Inbox, in the threads' place while open (server.js inboxOpen/openInbox; system.js): a `.thread.inbox` column whose
                         rows (Question) hold the thread link, who asked and when, the recap's newest open line (RecapLine, recap.js topicsOf),
                         the question (thread.js Body) and composer.js `Composer` with `inbox`, which sends without opening the thread; Dismiss
                         (server.js dismiss, the `inbox` list store)
  thread-details.js      DetailsPage, the side column's Details tab: title, people, family, tools and the memory switch for a thread;
                         a bot's threads open over them, with back
  pi-sessions.js         the "Import pi session" page settings' pi-sessions row opens (PiSessionList), and in thread details where one came from (PiSource)
  canvas.js              a thread's canvas as a page of the side column: tldraw and React loaded once from esm.sh (load), mounted as
                         a React island synced over /api/threads/:id/canvas (board), which only shows the board and grows shapes whose
                         labels don't fit (fitLabels), and tells the server what the person has selected and in view (reportSeen); CanvasRow, a canvas_act call's row in the chat
                         ("moved 3, deleted 1"), which opens the canvas on what changed (showOnCanvas)
  canvas/agent/          the JSON schema of canvas_act's actions, from tldraw's agent starter kit (README there; scripts/vendor-canvas-agent.js refreshes it)
  canvas/tldraw.js       tldraw from esm.sh, the one place its version is named for the browser
  recap.js               the side column's Recap tab: the recap as rows (topicsOf, Topic), a check when done, else a dot that works
                         while a thread it names is working; Page, whose #message-N links scroll the thread there; the refresh icon pulses while it's rewritten
  side.js                the side column: its pages (pagesOf: details, recap, canvas, director when on and the thread is a group), which one each thread shows
                         (sideOf, openSide, toggleSide), its tabs (PageTabs); system.js puts the page beside the thread
  director.js            the side column's Director tab: the director's activity events as rows (heardActivity, said), kept on this page only
  agent-memory.js        memory popover and compaction view for the visible thread
  icons.js               Icon: the client's stroke icons (up, back, plus, close, next, check, again, settings), one viewBox and weight
  title.js               defaultTitle shared by new-thread client paths, CLI, post and auto-title
  settings.js            server settings: a one-line row per module that opens to its description and options (memory's model,
                         compact-at, pi-sessions' import page), a pinned foot counting changes for Save and restart, Story back to the walkthrough
  system.js, wires.js    the live system diagram and the wires between boxes
  tutorial.js            walkthrough buttons wired to the real server
  tutorial-shed.js       loadShed: the example messages and their saved memory, loaded through the API
  tutorial-shed-memory.js   the real memory module’s recorded lines for the shed
  panes.js, popover.js, sure.js, notice.js, dot.js   Panes (a thing you open: its page, one opened over it with back,
                         a close; popovers and the side column), popover placement,
                         two-press button, error line, status dot
  quote.js               QuoteButton, one instance for the page: watches document selectionchange, shows a ghost button
                         CSS-anchored (base.css `.quote-anchor`) to a marker it plants at the selection's end inside a
                         message list, calling composer.js's appendQuote for that thread; nothing on a touch screen
  images.js, markdown.js image shrinking to pi's limits; message markdown, and threadMention, the `@"title"` a picked thread writes
  base.css               tokens, reset, every control's look (buttons and their variants), popover, rows, panes, status dot
  app.css                the chat's layout: list, threads, messages, composer, sheet, picker, settings, phone
  walkthrough.css        the story page and the live system's boxes and wires, all under body:not(.chat)
scripts/
  try.js                 scratch server beside a real runner in the caller’s folder, using echo/try
  page-spy.js            browser init script: fetches, socket frames, stalls
  solid-attribution.js   browser init script: Solid's attribution engine, for cost warnings and costs()
  vendor-canvas-agent.js refreshes canvas_act's actions schema from tldraw's agent starter kit
  replay-pi.js           replays pi sessions into a thread, to try memory
examples/all.js          the suite: every numbered example but the bench, half the cores at once, a timeout each, each one's time
examples/lib.js          what examples share: start (Node children), command (owns process groups through cleanup, including exited leaders' children), kill (awaits the exit), server, runner, scriptedRunner (answers at once; `tokensPerSecond` streams for an example that watches it write), api, view, until, quiet/settled/online (wait for state, not the clock), check
examples/NN-*.js         one promise a user relies on each, about twenty; the file name says which
examples/19, 23, 86–90-*-real-model.js   bench: memory recall, deep recall, introductions, another thread's
                                 fact, side question, directed mention and web search; REAL=1 only
examples/real-model-bench.js       real runner setup, delivery settling, evidence, step budgets and the `score` line
examples/real-model-bench.md       how to run the bench and its recorded baseline
```

Where a feature lives:

- Talk between threads: modules/talk.js (post, threads, reply), server.js append/whom, client thread.js `Cross` (a crossed message as a step row), run.js `Exchange`.
- Asking a model / switching it: composer.js pick/choose, model-picker.js, server.js whom/reconfigure.
- Live work you watch: server.js work/doing/watch, client agent.js doing, run.js Turn.
- Recaps: modules/recap.js, client recap.js, side.js (its tab and header button), thread.js (data-message), system.js (the column).
- Canvas: modules/canvas.js (rooms, tools, the socket, the actions' schema in apps/client/canvas/agent), client canvas.js (fitLabels), server.js upgrade (a module's `connect` takes /api/threads/:id/<module> sockets), client canvas.js, side.js PageTabs, system.js (which page the column shows).
- Memory and compaction: modules/memory.js, server.js compact/compactingAt, client agent-memory.js, thread.js rows (cuts, folded lines), run.js cutOf.
- Bots: modules/bots.js (DEFAULT_VOICE, voice, settings), client bot.js, composer.js PickerBot, client server.js homeBot/botAgent, client settings.js (the bots row's textarea); a bot's colour is server.js `colorOf` (its picked `color` hue, else by the order bots were made), picked in bot.js `BotSettings` `.colors`.
- Runners and keys: remote.js, runner.js, server.js mintKey/revoke/upgrade, client runner.js.
- Forks: server.js forkThread/seenBy, client server.js fork, thread.js Message (fork link).
- `$ cmd`: server.js Shell, printed, shells.
- Status dots: server.js status/busiest, client dot.js. Explicit questions waiting on a person: modules/blocked.js, util.js byAgent.
- The inbox: modules/inbox.js (over blocked's openQuestion), client inbox.js, server.js inbox/dismiss/inboxOpen, thread-list.js (its toggle), system.js (in the threads' place), composer.js `inbox`.
- Pi session files, both ways: modules/pi-sessions.js; the runner's messages are `pi-session`, `pi-session-list` and `pi-session-read` in remote.js serveRunner, shipped with the runner through RUNNER_FILES; cli.js `import`.
- Wakes: modules/wake.js, util.js byAgent/said (`wake` marks the message), client wake.js, composer.js (the strip), thread.js (rows, WokeLine), time.js `ahead`.
- Settings and modules: modules.js, server.js saveSettings/restart, client settings.js.
- A page behind its ade: server.js hashOf/clientVersion (`client` in GET /api/server, `server` named on the socket when apps/client changes), git, GET /api/changes (the commits since the page's), client server.js `behind`/`changes`, thread-list.js (Update in the list's foot, with the count of commits).
- The desktop window: apps/desktop main.go (window, links, offline page, notifications, updater), preload.js (notifications from the thread list, the clipboard on plain http), release.sh (`pnpm desktop:release`).

## UI parts

Build from these; a new panel, row or button takes its sibling's markup and class, and adds no CSS of its own. A control (button, input, select, textarea, checkbox) gets its look only in base.css, from its element or a variant class; a rule for a place sets its layout only. Quoted names are the CSS files' section comments.

- Buttons, three variants ("Three buttons"): bordered is plain `button` (Done, Create, Copy, archive, fork, revoke); `button.ghost` has no border and gets a soft fill on hover and when `aria-pressed` or `aria-expanded` (composer bar, foot toggles, closes, backs, thinking levels); `button.primary` is filled with ink (send). `data-danger` turns any of them red on hover. One size modifier, `.small` (12px: the composer bar, row ends, Done, options, thinking levels, backs, pane closes, Copy, Create, foot toggles). Two more classes keep a look of their own: `.send`, the one round button, and `.row`, a link as wide as its list. Fields share one look (`input`, `textarea`, `select`), plus `.bare` for a name that reads as a heading and `.draft` for the composer's box.
- Popover: a `div.popover[popover]` placed by `placePopover` (popover.js), a bottom sheet on phones ("The model picker and settings"). Panes inside it (panes.js `Panes`, `.panes .pane`, "A detail covers") give it a header with a ghost close (shown only on a phone's sheet), a back and actions, and an optional `foot` pinned under the scrolling body. Settings (settings.js), Runners (runner.js `.runner-list`) and Context (composer.js `.recall`) use it; the model picker and @mentions (composer.js `.model-picker`) are the same frame without panes.
- Popover rows: `ul.rows > li` in a popover's pane body, one per module, runner or option ("One row across"); the picker's `.model-controls .who` and `.model` share the look.
- Model controls: model-picker.js `ModelPicker`, `.model-controls`: a `.search` pinned on top (typing filters, arrows and Enter pick, recipients go to `onRecipients`), the `.model-list` of runners' `.models` that alone scrolls (scoped ones first; an "All models" row or a search reaches every model the runner is logged in for), and a pinned `.foot` with the asked runner's `.thinking` and a folder field, any path with its shortcuts suggested ("A search, then each runner's models"); the composer and settings share it.
- Left aside: thread-list.js `ThreadList`, `.thread-list`; New thread and New bot share `ul.new-rows` on top; each row is `li > .row` (a link, or a button, or `form.row` for a new bot), shared with the family list `.thread-family`; its foot is `.list-foot` with `.foot-toggle`s ("The list's foot").
- Side column: `aside.side` ("The side column"), one page at a time in the same `Panes` as a popover, side.js `PageTabs` in its header: thread-details.js `DetailsPage` (`.thread-details`), recap.js `Recap` (`.recap`), canvas.js `Canvas` (`.canvas`), director.js `Director` (`.director`); a bot's part is bot.js `BotSettings`, `.bot`; its fields are plain inputs.
- Thread head: the thread's name, `h2.title > button.ghost.thread-name` (opens the side column on Details; its tabs do the rest), and its `.close` ("The head:"); the head, `p.from` and the phone's `.app-bar` ("The bar") sit on `Canvas` so messages scroll under them; `.thread-name` is layout only.
- A thread-list page (Archived) has `.page-head`.
- Message list: thread.js `Message` in `.thread > ul > li` ("The chat: agents write"), its body `.markdown`, its images `div.images`, compaction's `li.cut` and `li.line`.
- Quoting a selection into the composer: quote.js (the button, CSS-anchored to the selection), composer.js `appendQuote`, app.css `.quote-anchor`/`.quote`.
- Tool calls: run.js `Turn`, `Exchange`, `Step`, `Call`; `li.turn` is a `<details>` whose open list is `.steps`, its tools `.tool` and its words `.said`; `.exchange` and a crossed message are a `.steps` list of thread.js `Cross` rows (`li.sent`, `li.received`). There's no thinking block: a live turn's summary says "thinking".
- Composer: composer.js `Composer`, `.thread form`: the box, `.bar` with `.icon` buttons, `.pick` (whom it asks, in which folder) and `.stop`, and `ul.images` waiting to go.
- Small parts: sure.js `Sure` (`.sure`, a button that asks by changing its words), busy.js `busy`/`Busy` (`.busy`, a button waiting on the server: ↻ turning for half a second at least, then a check; recap refresh, Save and restart, Add runner, revoke), notice.js `Notice` (`.notice`, what went wrong, above the active composer's input), dot.js `Dot` (`.dot`, status).
