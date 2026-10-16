# Draw & Guess

A mobile-first multiplayer drawing and guessing game for the browser.

**Current state: Phase 3 (full matches).** A player creates a room and invites friends. The host starts a **five-round match**: each round, one player draws a secret word while the others guess. The server scores every correct guess, shows round results, and after round five shows a final leaderboard with **Play Again** and **Return to Lobby**.

**Deployment:** the repo is ready to deploy to Render's free tier with one click-through (see [Deploying](#deploying-to-render-free)). The public URL is listed here once it's live: _not deployed yet_.

## Tech stack

| Layer  | Tools |
| ------ | ----- |
| Client | React 19, TypeScript, Vite 8, Tailwind CSS 4, socket.io-client, HTML Canvas + Pointer Events |
| Server | Node.js, Express 5, Socket.IO 4, TypeScript (tsx in dev) |
| Shared | `@draw-guess/shared`: event contracts, game types, constants, validators |

npm workspaces tie the three packages together. There's no database and no authentication. All room, match and round state lives in the server's memory.

## Requirements

- Node.js **20.12 or newer** to run the app (tested on Node 26.3, npm 11.16)
- For `npm run test:e2e` only: Node **22+** and a local Google Chrome/Chromium

## Getting started

```bash
npm install
cp .env.example .env     # optional: defaults work without it
npm run dev
```

`npm run dev` builds the shared package, then runs three processes together:

- `shared`: TypeScript watch build
- `server`: game server on <http://localhost:3001>
- `client`: Vite dev server on <http://localhost:5173>. **Open this one.**

Vite proxies `/socket.io` and `/api` to the server, so the browser only ever talks to one origin.

### Scripts (run from the repo root)

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Development: shared watch, server with auto-restart, Vite with hot reload |
| `npm run typecheck` | Type-checks shared, server (including tests) and client (including tests) |
| `npm test` | Server unit tests, Socket.IO integration tests, and client drawing-logic tests (Node's built-in test runner) |
| `npm run test:e2e` | Builds, then plays lobby flows, drawing rounds and a full five-round match in headless Chrome. Set `CHROME_PATH` if Chrome isn't found, and `E2E_SHOTS=<dir>` to save screenshots |
| `npm run build` | Production build of all three packages |
| `npm start` | Runs the built server. It also serves `client/dist` on port 3001, so run `npm run build` first |
| `E2E_URL=https://… node e2e/lobby.e2e.mjs` | Runs the same browser tests against an **already running** server (e.g. your public deployment). It waits for a sleeping server to wake, skips the local-only server-restart check, and fails on CORS/mixed-content browser errors |

Health check: `GET /api/health` returns `{ status, uptimeSeconds, rooms, players, connections }`.

## Deploying to Render (free)

The server already serves the built client from the same origin, so **one Render web service hosts everything** (website + Socket.IO + health check). Same origin means no CORS configuration. Render terminates HTTPS and supports secure WebSockets (`wss://`); the client connects to whatever origin served the page, so it never uses `localhost` in production.

**Why Render:** Fly.io no longer has a free tier, Railway's free credit is small, and Vercel/Netlify can't host a persistent Socket.IO server. Render's free web service supports WebSockets (checked against Render's docs, 2026-10-17).

**Free-tier limits (read before inviting friends):**
- The service **sleeps after 15 minutes without traffic** and takes **about a minute** to wake. The first visitor waits; the game shows a "server is waking up" message.
- **Rooms and games live in memory.** When the service sleeps or redeploys, every room ends. Keep one tab open or play within a session; don't expect rooms to survive overnight.
- 750 free instance hours per month per workspace (enough for one always-on service), one instance only, bandwidth counts against a monthly allowance.

### Steps (you do these: they need your Render and GitHub accounts)

1. **Push the code** (`render.yaml` must be on GitHub's `main`). See "What to commit" in BUILD_STATUS.md, or:
   ```bash
   git add -A && git status        # check that .env is NOT listed
   git commit -m "Phase 4: deployment config"
   git push
   ```
2. Sign in at <https://dashboard.render.com> with GitHub.
3. **New → Blueprint**, pick your repo, branch `main`. Render reads [render.yaml](render.yaml) and shows one free web service, `draw-and-guess`. Click **Apply**. Render may ask you to add a payment method at this step. I couldn't verify whether the free plan requires one, so read the screen before continuing, and pick the free plan.
4. Wait for the build (about 3–6 minutes). The service URL looks like `https://draw-and-guess.onrender.com` (Render adds a suffix if the name is taken).
5. **Check it:** open `<url>/api/health` (expect `{"status":"ok",…}`), then open `<url>` and create a room.

**Manual setup instead of the blueprint:** New → Web Service → your repo, Runtime *Node*, Instance *Free*, Region *Singapore*, then:

| Setting | Value |
| ------- | ----- |
| Build command | `npm ci --include=dev && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Env var `NODE_VERSION` | `22` |
| Env var `NODE_ENV` | `production` |

`--include=dev` matters: the build needs TypeScript, Vite and Tailwind, which are dev dependencies and are skipped by a plain `npm install` when `NODE_ENV=production` (this was reproduced and fixed). Render provides `PORT` itself. **Leave `CORS_ORIGINS` and `VITE_SERVER_URL` unset.** No secrets are needed; never put real values in `.env.example` or commit `.env`.

**Updating:** pushing to `main` redeploys automatically (`autoDeployTrigger: commit`). To redeploy by hand: Render dashboard → your service → *Manual Deploy*.

**Test the live game from your computer** (needs Chrome and Node 22):
```bash
E2E_URL=https://YOUR-SERVICE.onrender.com node e2e/lobby.e2e.mjs
```
This plays a full room → draw → guess → five-round match → rematch flow against the public URL (the first run may spend a minute waking the server).

**Optional: frontend and backend on different hosts.** Build the client with `VITE_SERVER_URL=https://your-server` (baked in at build time) and start the server with `CORS_ORIGINS=https://your-frontend` (exact origin, no trailing slash). This setup is tested locally (the browser suite passes with it, and fails with CORS errors if `CORS_ORIGINS` is missing), but it is not what `render.yaml` configures.

## Match rules

- **2–8 players.** The host starts a match from the lobby when at least 2 players are connected.
- **Exactly 5 rounds.** In each round:
  1. One player is the drawer and picks 1 of 3 secret words (15s; otherwise one is picked for them).
  2. They draw it for **60 seconds**.
  3. Everyone else types guesses into the chat.
- **A round ends** when the timer runs out, every connected guesser has guessed, the drawer leaves, or too few players remain. The word is then revealed with a **round-results card**: the drawer, who guessed, points this round, and running totals.
- **Moving on:** the results stay up for 8 seconds (`ROUND_RESULTS_MS`), then the next round starts automatically. The host can skip ahead with **Next round**.
- **After round 5**, the **final leaderboard** shows everyone ranked by score, with a winner announcement. Ties share a rank (1, 1, 3), and "It's a tie!" names everyone in first place. If nobody scored, there's no winner. The leaderboard stays until the host picks **Play Again** (a fresh match: scores, rounds, results and canvas all reset) or **Return to Lobby** (match cleared; everyone keeps their seat). The host can also return to the lobby mid-match from the **⋮** menu.
- **Drawer rotation:** whoever has drawn the fewest times this match draws next. The previous drawer never draws twice in a row while anyone else is available. Ties go to the next player in join order, and only connected players are picked. With 2 players the order is A, B, A, B, A; with 5 or more, five different players draw.
- **Words:** a word offered to a drawer (picked or not) is never offered again in that room until the 152-word list runs out.

### Players coming and going

| Situation | What happens |
| --------- | ------------ |
| A player disconnects | They keep their seat, score and "guessed" status for `RECONNECT_GRACE_MS` (30s) and rejoin automatically. They don't hold up an "everyone guessed" finish. |
| A guesser leaves (or their seat expires) | They're removed from the standings; the round and match continue. |
| The drawer leaves mid-round | That round ends ("The drawer left") and still counts as one of the five; points already earned are kept. |
| The host leaves or stays disconnected for 10s | Host passes to the longest-standing connected player, who gets the Next round / Play Again controls. |
| Fewer than 2 players **connected** between rounds | The match **pauses** on the results card ("waiting for players to reconnect") and resumes 3s after someone returns. |
| Fewer than 2 players **left in the room** | The current round ends; then the match ends early, with a final leaderboard explaining why. |
| Someone tries to join mid-match | Refused ("That game has already started"). Rooms are locked from Start until the host returns to the lobby, so a match never contains a player in an undefined state. To add players, use Return to Lobby. |

## Scoring

The server calculates every point; clients never send scores, round numbers, drawer identity or "correct" flags.

- **Correct guess:** `base + speed bonus`, at most **100**.
  - `base = max(20, 50 − 10 × (order − 1))`. The 1st correct guesser gets 50, the 2nd 40, the 3rd 30, the 4th onward 20.
  - `speed bonus = round(50 × timeLeft / 60s)`, from 0 to 50.
  - Example: the first guesser with 45s left earns 50 + 38 = **88**.
- **Drawer:** **25** for every player who guesses correctly.
- **Zero points** for wrong guesses, chat, the drawer (who can't chat during a round), and any message that only *contains* the answer.
- **Once per word:** each player scores at most once per round. Repeats, reconnects and racing timers can't award points twice. Points are added at the instant the server accepts the guess, and a round ending never awards anything.
- **Simultaneous guesses** are ordered by when the server receives them.
- **Timing:** a guess arriving after time is up (even a millisecond before the timer fires) doesn't count.

The values live in `SCORING` (`shared/src/game.ts`) and `server/src/game/scoring.ts`.

## Testing a complete match with several browser sessions

Each browser **tab** is a separate player, because seat credentials are stored in `sessionStorage`. The most reliable setup is windows that don't share storage: a normal window, a private/incognito window, and a second browser.

1. `npm run dev`
2. **Window A** (normal): open <http://localhost:5173>, enter `Alice`, tap **Create Room**, then **Copy invite**.
3. **Window B** (private window): open the invite link, enter `Bob`, tap **Join**. Optionally add **Window C** (another browser) as `Cara`.
4. In A, tap **Start Game**. Every screen shows **RD 1/5** next to the player list, with each player's score.
5. **Each round:**
   1. The drawer (Alice in round 1) sees "Pick a word to draw" and picks one. Their header shows the word and the timer starts at 60.
   2. The drawer draws with a finger or the mouse. The others see letter slots (e.g. `_ _ _ _ _ · 5 letters`).
   3. Guessers type guesses. A wrong guess appears in everyone's chat. A message that merely contains the answer ("is it a cat?") is shown only to its sender, the drawer and players who already guessed. The exact word gives "You guessed the word! +NN".
   4. The round ends when everyone has guessed or time runs out. The **results card** shows the word, the drawer, who guessed, `+points` this round and totals. It counts down "Round 2 in 8s". The host can tap **Next round**.
6. Check the rotation: with two players, Alice, Bob, Alice, Bob, Alice; with three, Alice, Bob, Cara, Alice, Bob.
7. After round 5's results ("Final results in…", or **See final results**), every screen shows the **final leaderboard**: ranks, scores, "Guessed N · Drew N", and "Alice wins!", "You win!" or "It's a tie!".
8. In A (host), tap **Play Again**. Everyone returns to **RD 1/5** with scores at 0 and a blank canvas. Tapping twice still starts only one match.
9. Finish or abandon the match, then use **Return to Lobby** (on the leaderboard, or **⋮ → Back to lobby**). Everyone is back in the lobby, still seated.

Edge cases worth trying:
- **Reloading:** reload a guesser mid-round. Their score, guessed status and the drawing come back.
- **Host leaves:** close the host's window. After about 10s someone else gets the host controls.
- **Pause:** with 3 players, disconnect two between rounds. The results card says the match is paused; reconnect one and it continues.
- **Early end:** with 2 players, close one window for 30s. The match ends early with a leaderboard explaining why.

### Testing on a phone

Set `DEV_HOST=0.0.0.0` in `.env`, restart `npm run dev`, and open the "Network" URL that Vite prints (e.g. `http://192.168.1.20:5173`) on a phone on the same Wi-Fi. Things to try:
- Draw in portrait, then rotate the phone; landscape uses a side-by-side layout.
- Open the keyboard to guess; the input stays visible.
- Check the results card and leaderboard at your phone's width.

## Configuration

All settings live in a single root `.env`, which both the server and Vite read. See [.env.example](.env.example).

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `3001` | Game server port (Vite proxies to it) |
| `HOST` | `0.0.0.0` | Server bind address |
| `CORS_ORIGINS` | *(empty)* | Comma-separated **exact** origins, only for a frontend hosted on another origin (unset on Render) |
| `MAX_PLAYERS_PER_ROOM` | `8` | Clamped to 2–8 |
| `MAX_ROOMS` | `500` | Server-wide cap on simultaneous rooms |
| `RECONNECT_GRACE_MS` | `30000` | How long a dropped player keeps their seat |
| `HOST_HANDOFF_MS` | `10000` | How long a dropped host stays host before the role moves to a connected player |
| `WORD_CHOICE_MS` | `15000` | Time the drawer has to pick a word; after that, one is picked for them |
| `ROUND_DRAW_MS` | `60000` | Length of the drawing/guessing phase |
| `ROUND_RESULTS_MS` | `8000` | How long round results stay up before the match moves on by itself |
| `DEV_HOST` / `CLIENT_PORT` | `localhost` / `5173` | Vite dev server bind address and port |
| `VITE_SERVER_URL` | *(empty)* | Absolute server URL when not same-origin; read at client **build** time (unset on Render) |

## Project structure

```
shared/src/
  constants.ts        room/nickname limits, room-code alphabet, player colors
  events.ts           ClientToServerEvents / ServerToClientEvents (the socket contract)
  game.ts             drawing ops, brush palette, limits, MATCH_ROUNDS, SCORING, round/match/chat types
  types.ts            RoomPhase, RoomSnapshot, PublicPlayer, JoinedRoom
  errors.ts           error codes + user-facing messages, AckResult<T>
  validation.ts       nickname / room-code normalization and validation
server/src/
  createApp.ts        Express + Socket.IO wiring; routes private messages and scoped chat to sockets
  config.ts           env parsing (loads root .env)
  rooms/RoomManager.ts  socket-free state machine: seats, host hand-off, match, rounds, scoring, chat, drawing
  game/scoring.ts     guess points, tie-aware ranking, winners
  game/rotation.ts    fair drawer choice
  game/words.ts       curated easy-to-draw word list + picker
  game/guess.ts       guess normalization, hint masking, answer detection, chat text cleaning
  game/drawing.ts     draw-op validation and the per-round stroke store
  socket/             event handlers, payload validation, per-socket rate limits
server/test/          unit tests (rooms, rounds, matches/scoring) + Socket.IO integration tests
client/src/
  lib/gameStore.ts    socket → store bridge, actions, auto-rejoin, round catch-up, countdown deadlines
  lib/strokeBoard.ts, boardRenderer.ts, drawSender.ts, drawBatching.ts   drawing engine
  lib/useGameViewport.ts  pins the game screen to the visual viewport (mobile keyboard)
  screens/            HomeScreen, LobbyScreen, GameScreen
  components/         DrawingCanvas, DrawingToolbar, ChatPanel, RoundOverlay (word choice + results),
                      FinalLeaderboard, RoundTimer, PlayerStrip (round counter + scores), GameMenu, …
client/test/          stroke-board and batching tests
e2e/                  dependency-free headless-Chrome tests (Chrome DevTools Protocol); can target a deployed URL
render.yaml           Render blueprint: one free web service (build, start, health check)
```

## Architecture notes

- **The server is authoritative.** The client sends intents (`game:start`, `round:chooseWord`, `chat:send`, `round:next`, `match:playAgain`, …). The server validates every payload as untrusted input, applies it, and broadcasts a full `room:state` snapshot. Unknown events are ignored.
- **State machine** (in `RoomManager`): `lobby → choosing → drawing → round-end → (choosing | match-end) → (choosing via Play Again | lobby)`.
  - Every transition first checks the current phase and who is asking. A repeated request, or a timer firing after the host already acted, is a no-op (the request gets `INVALID_PHASE`).
  - Leaving round-end always goes through a single `advance()`, shared by the results timer and the host's Next round.
  - Every transition cancels the timers of the state it leaves. Timer callbacks are wrapped so an exception is logged instead of crashing the process.
- **Word secrecy.** The word and choices live only in server-side round state. Before a round ends, the public snapshot has only a masked hint. Round results, including the word, appear only once the round is over. The drawer gets their choices and word via `round:private`, as does anyone who guesses correctly. Messages that would reveal the answer are scoped to players who already know it.
- **Drawing protocol.** The canvas is square, with integer coordinates `0..2000`. The drawer sends batched `begin / points / end` ops (`draw:ops`, about every 40ms). The server checks the drawer, socket and round, validates and stores the ops, and relays the cleaned ops. `JoinedRoom.game` lets a (re)joining player catch up.
- **Players have stable IDs, separate from socket IDs.** A secret `sessionToken` lets a player reclaim their seat (`room:rejoin`). Scores and guessed status are keyed by player ID, so reconnecting never resets or duplicates them.
- To add an event: declare it in `shared/src/events.ts`, handle it in `server/src/socket/registerHandlers.ts`, and add an action in `client/src/lib/gameStore.ts`.
