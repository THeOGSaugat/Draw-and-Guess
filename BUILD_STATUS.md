# Build Status

_Last updated: 2026-10-17. Phase 4: deployment preparation (on top of Phases 1–3)._

**Deployment status: prepared and verified locally, NOT yet deployed.** Creating the Render service needs your Render/GitHub login, which I can't do. Public URL: _pending_ (steps in [README → Deploying](README.md#deploying-to-render-free)).

## Phase 1 checklist

### Project foundation
- [x] npm workspaces monorepo: `client/`, `server/`, `shared/`, plus `README.md` and `.env.example`
- [x] TypeScript throughout, with a shared strict base config (`tsconfig.base.json`)
- [x] Shared package for socket event contracts, types, constants and validators
- [x] Root scripts: `dev`, `typecheck`, `test`, `build`, `start`
- [x] Single root `.env`, read by both the server and Vite
- [x] `GET /api/health` endpoint
- [x] Production mode: the server serves the built client from the same origin

### Features
- [x] 1. Home screen with nickname input (live length counter, inline validation, remembered between visits)
- [x] 2. Create Room and Join Room buttons
- [x] 3. Short unique room codes: 5 characters, no look-alike characters (0/O/1/I/L), collision-checked
- [x] 4. Join by room code (input is case- and dash-insensitive) or via an invite link (`/?room=CODE` pre-fills the code)
- [x] 5. Mobile-friendly lobby with a live player list, per-player colors, an "open seats" row, and connected/disconnected status
- [x] 6. Host crown and badge; Start Game button only for the host, enabled at 2+ connected players
- [x] 7. Shareable invite link with Copy invite, tap-to-copy code, and the native Share sheet where supported
- [x] 8. Connection indicator (Online / Connecting… / Reconnecting…) plus a lobby banner when the connection drops
- [x] 9. Validation for invalid room codes, unknown rooms, duplicate nicknames (case-insensitive), full rooms, and games already in progress
- [x] 10. Server-side room management for 2–8 players: join/leave, host hand-off, empty-room cleanup, server-wide room cap

### Beyond the brief (supports later phases)
- [x] Seat recovery: reloading a tab or briefly losing connection reclaims the same seat (session token, 30s grace period)
- [x] When the same seat is opened in a second tab, the first tab is told and leaves cleanly
- [x] Start Game really changes server state and locks the room to new joins. (In Phase 2 it starts a real round; see below.)
- [x] Per-connection rate limiting; payload size and shape checks on every event; events without an acknowledgement callback are dropped

### Design
- [x] Deep navy theme, candy-colored accents, rounded panels, Fredoka and Nunito fonts
- [x] Subtle animations (pop-in, float, wiggle), disabled when the OS asks for reduced motion
- [x] Mobile portrait first; two-column lobby at tablet/desktop widths (≥768px)
- [x] No horizontal scrolling at 320px, 390px, 768px or 1280px (measured in headless Chrome)
- [x] Respects safe-area insets (notches); inputs are ≥16px so iOS doesn't zoom on focus

### Bug-fix pass (before Phase 2)
Each fix has a regression test (unit/integration or e2e) that was seen failing first.
- [x] **Nicknames in Devanagari and other scripts that use combining marks** (e.g. "सौगात") were rejected. Combining marks are now allowed, and names made only of punctuation are rejected.
- [x] **A failed rejoin kicked the player out of their current room.** The server dropped the current seat before checking the new session token. It now validates first. Room creation got the same fix: a failed create (e.g. server full) no longer costs the current seat.
- [x] **Ghost seat:** a socket that reclaimed a different seat in the same room left its old seat marked "connected" forever. The old seat is now released.
- [x] **Duplicated browser tab stole the original tab's seat** (the copied `sessionStorage` let it take over). Tabs now check with each other over `BroadcastChannel`. The duplicate starts fresh on the home screen with the room code filled in.
- [x] **Slow server response left a ghost player.** If a create/join answer arrived after the client's 8s timeout, the player was in the room on the server but not on screen. Late answers are now applied.
- [x] **Host drop blocked the room for 30s.** The host role now moves to a connected player after `HOST_HANDOFF_MS` (10s) and returns to normal if the host reconnects in time. Guests see a "host lost connection" message meanwhile.
- [x] **"Seat expired" lost the room code.** After an expiry or a seat takeover, the home screen keeps the code filled in for rejoining.
- [x] **Pasting a full invite link into the code box** turned it into garbage (`HTTPL`). The code is now pulled out of the link.
- [x] **IME users** (Devanagari, Japanese, …) submitted the form by pressing Enter to confirm a composed character. Enter is now ignored while composing.
- [x] **Lobby header hid the "Draw & Guess" wordmark below 400px** (most phones). The connection badge is now a dot at narrow widths; the offline banner still explains disconnects.
- [x] Leave button on the in-game screen now shows a loading state.

## Phase 2 checklist

### 1. Drawing canvas
- [x] HTML Canvas + Pointer Events: finger, mouse and stylus (stylus uses the same pointer path as touch; pressure is ignored)
- [x] 10-color palette, 4 brush sizes, eraser, and Clear with a two-tap confirmation ("Sure?")
- [x] Smooth strokes: coalesced pointer samples and midpoint quadratic curves
- [x] Resolution-independent coordinates (square canvas, integer coords 0–2000), so drawings match on every screen
- [x] High-DPI backing store (`devicePixelRatio`, capped at 2048px)
- [x] Full redraw on resize/rotation; DPR changes after load are handled via a `resolution` media query
- [x] `touch-action: none` on the canvas; the game screen is fixed to the visual viewport, with page scroll and pull-to-refresh disabled while it's open
- [x] Large canvas on phones: full width in portrait, side by side with chat in landscape and on desktop

### 2. Real-time drawing sync
- [x] Ordered `begin / points / end` ops, batched about every 40ms (never the whole canvas), split so each message stays far under the server's size limit
- [x] Clear is synced and ordered after any queued strokes
- [x] Current drawing restored for players who reload or reconnect, including a stroke still in progress
- [x] Only the drawer, on their current socket, in the current round and drawing phase, can draw. Everything else is dropped.
- [x] Every op is validated: shape, palette color, brush size, coordinate range, increasing stroke ids, per-batch/stroke/round limits. Only cleaned ops are relayed.
- [x] Separate draw rate limit (100 batches / 2s); listeners, timers and queued ops are cleaned up on round change, leave, and unmount
- [x] All event names and payloads live in `shared/` (`events.ts`, `game.ts`)

### 3. Secret word selection
- [x] Curated list of 152 easy-to-draw words (server only)
- [x] Server picks 3 distinct candidates, avoiding words already used in the room
- [x] Only the drawer receives them (`round:private`). If the drawer doesn't pick within `WORD_CHOICE_MS` (15s), the server picks one.
- [x] Others see only a masked hint (letter slots plus letter count)
- [x] The word never appears in public state, broadcasts, chat, errors or the guesser's DOM before the round ends (checked in unit, socket and browser tests)

### 4. Guessing and chat
- [x] Mobile chat panel with guess input, auto-scroll, and accessible log
- [x] 1–100 characters; control/zero-width characters stripped; chat rate limit 5 messages / 5s plus the general limit
- [x] Server-side matching that ignores case, surrounding/extra whitespace and hyphens
- [x] Correct guesses are announced without the word ("Bob guessed the word!") and shown distinctly from chat
- [x] Repeating the answer never counts twice and isn't broadcast
- [x] After guessing, a player's messages go only to the drawer and other guessed players ("guessed only")
- [x] The drawer can't chat during the round; there's no event a client can use to mark itself correct
- [x] No points awarded (scoring is Phase 3)

### 5. Simple round flow
- [x] Explicit server state machine: `lobby → choosing → drawing → round-end → (choosing | lobby)`. Every transition is validated.
- [x] Host starts with 2+ connected players. Fair rotation in join order skips disconnected players and continues across rounds.
- [x] Server-controlled 60s drawing timer (`ROUND_DRAW_MS`); clients show a countdown from server-sent remaining time
- [x] Round ends when the timer expires, everyone connected has guessed, the drawer leaves, or too few players remain
- [x] Word revealed at the end; host can start a **Next round** or go **Back to lobby** (also from the ⋮ menu mid-round)

### 6. Mobile & accessibility
- [x] No horizontal scroll and canvas fully visible at 320, 360, 390, 430px, tablet (768) and desktop (1280); landscape 844×390 too
- [x] Guess input stays on-screen with the keyboard open (canvas shrinks instead)
- [x] Drawing doesn't scroll the page (checked: scroll position stays 0 during touch drawing)
- [x] Toolbar touch targets ≥ 36px; long nicknames truncate; Devanagari nicknames work in-game
- [x] Readable timer (`role="timer"`) and connection dot plus offline banner
- [x] Accessible names on all controls (`aria-pressed` on tool toggles, labeled menu, `role="log"` chat); visible focus rings

### Phase 2 bugs found and fixed during development
- [x] **Rejoining drawer lost strokes after a clear:** stroke ids must keep increasing, but a reconnecting drawer only knew the ids of strokes still on the canvas. The server now sends `nextStrokeId` (regression test in `round.test.ts`).
- [x] **Oversized draw batches could disconnect the drawer:** one batch could exceed Socket.IO's 100 KB limit. Batches are now capped (`drawBatching.ts`, tested).
- [x] **Blurry canvas after a DPR change without a resize** (window moved to another monitor): now handled via a media query (see untested scenarios).
- [x] **Lobby chat spam:** the server accepted chat in the lobby, which has no chat UI. It's now rejected (tested).
- [x] Landscape phones got a tiny canvas in the stacked layout; landscape now uses the side-by-side layout.

## Phase 4: deployment

### Hosting choice (checked against provider docs on 2026-10-17)
- **Render free web service (chosen).** Supports WebSockets and persistent Node processes. Limits: sleeps after 15 min without traffic, about 1 min to wake, 750 free instance hours/month, single instance, no persistent disk. Source: [Render free-tier docs](https://render.com/docs/free).
- **Rejected:** Fly.io (no free tier for new customers; 2-hour/7-day trial), Railway (30-day $5 trial credit, then $1/month credit), Vercel/Netlify (no persistent WebSocket server).
- **Why one service:** the server already serves the built client, so the game, Socket.IO and the health check share one HTTPS origin. This removes CORS from the default setup.

### Production-readiness audit
| Check | Result |
| ----- | ------ |
| Client uses a configurable backend URL | Yes: `VITE_SERVER_URL` (build time); blank = same origin |
| Never connects to localhost in production | Verified: the built bundle has no hard-coded URL. It connects to the page's own origin (the only "localhost" strings are inside the socket.io library) |
| Server uses the host's `PORT` | Yes. Verified by running with `PORT=10000` |
| CORS allows the exact frontend origin | Yes, and nothing else. **New tests** (`server/test/cors.test.ts`): none by default; exact-origin allow-list; rejects look-alikes (`http://`, subdomains, suffix tricks); preflight works |
| Socket.IO over HTTPS/WSS | Same-origin `io()` follows the page's scheme (`https` → `wss`). Not testable without a real HTTPS host: **needs your check on the live URL** |
| Secrets not committed | No secrets exist yet. `.env` is git-ignored and untracked; `.env.example` has placeholders only. Secret scan of tracked files found nothing |
| Health endpoint | `GET /api/health` works (also used as Render's health check) |
| Production build | Works with `npm ci --include=dev && npm run build` |
| Game features in production mode | Full browser suite (rooms, drawing, guessing, scoring, five-round match, rematch, reconnect) passes against a production-built server |

### Issues found and fixed
- **Build fails with `NODE_ENV=production`.** A plain `npm install` skips dev dependencies (TypeScript, Vite, Tailwind), so `npm run build` fails with `tsc: command not found`. Reproduced in a clean copy; fixed by using `npm ci --include=dev` in `render.yaml` (verified in a clean copy).
- **First-visit wait on a sleeping free server** looked like a hang. The home and reconnect screens now say "The server may be waking up… up to a minute" after 6 seconds offline.
- **Test-harness flaws** found while building the deployed-URL mode: Chrome start-up timeout too short, and a cleanup crash that hid the results summary. Both fixed.

### New and changed files
- `render.yaml`: Render blueprint (free web service, Singapore region, build/start/health check, Node 22)
- `server/test/cors.test.ts`: 4 CORS regression tests
- `e2e/lobby.e2e.mjs`: new `E2E_URL` mode (test a deployed server), captures browser console errors and fails on CORS/mixed-content
- `client/src/lib/useSlowConnect.ts` + `HomeScreen.tsx` + `App.tsx`: "waking up" hint
- `.env.example`: documented deployment placeholders. A private `.env` exists locally and is git-ignored.
- `README.md`, `BUILD_STATUS.md`

### What to commit (I have not committed or pushed anything)
Review with `git status` and `git diff`, then commit everything above, for example:
```bash
git add -A && git status    # confirm .env is NOT in the list
git commit -m "Phase 4: Render deployment config, CORS tests, deployed-URL e2e mode"
git push
```

### Verification performed (Phase 4)
- [x] `npm run typecheck`: clean
- [x] `npm test`: **90/90** (86 server including 4 new CORS tests, 4 client)
- [x] `npm run build`: succeeds
- [x] `npm run test:e2e` (local server): **27/27**
- [x] **Render-style clean-room run:** fresh copy of the project with no `node_modules` and no `.env`, `NODE_ENV=production npm ci --include=dev && npm run build`, started with `PORT=10000 npm start`:
  - health, page, assets and unknown-API 404 respond correctly
  - the full 27-check browser suite passes against it through the new `E2E_URL` mode
- [x] **Split frontend/backend run:** client built with `VITE_SERVER_URL=http://127.0.0.1:10000` served from another origin (`:4173`). With `CORS_ORIGINS=http://127.0.0.1:4173` all checks pass. Without it, the suite fails with 42 "blocked by CORS policy" errors, proving the test catches the misconfiguration.
- [x] `render.yaml` parses and its fields match [Render's blueprint docs](https://render.com/docs/blueprint-spec)
- [ ] **Not done: the actual deployment and every check on the public URL** (create room from two networks, wss, live drawing, a five-round match, rematch, reconnect, backend logs). These need the deployment first, then your devices; see below.

### What you need to do
1. Commit and push (above), then follow [README → Deploying](README.md#deploying-to-render-free) (Render dashboard → New → Blueprint → Apply).
2. Check `<url>/api/health`, then run `E2E_URL=<url> node e2e/lobby.e2e.mjs` from this project (needs Chrome and Node 22).
3. **Manual two-device test:** on your phone (mobile data, not Wi-Fi) open the URL and create a room; on your computer join with the invite link. Check live drawing, a guess, and a full five-round match plus Play Again. Open Render's *Logs* tab while testing and watch for errors.
4. Put the working URL at the top of README.md and in this file.

### Limitations specific to this deployment
- Free tier sleeps after 15 minutes idle; wake-up takes about a minute; **all rooms are lost on sleep or redeploy** (in-memory state).
- A redeploy (any push to `main`) ends running games.
- Single instance only (state is in memory), so the free tier is also the right architecture today.
- No custom domain, analytics or rate limiting by IP; the game has no accounts.
- Not verified: how Render's free plan treats long idle WebSocket connections during a quiet game (its docs say idle connections count as inactivity). Active play generates traffic every few seconds, so this should not matter in practice, but it hasn't been observed.

## Phase 3 checklist

Match rules, the scoring formula, and the join/leave rules are documented in [README.md](README.md#match-rules).

### 1. Five-round match system
- [x] A match is exactly 5 rounds (`MATCH_ROUNDS`); each round's drawing phase is 60s once the word is picked
- [x] Fair drawer rotation:
  - fewest draws first, then next in join order; connected players only
  - never the same drawer twice in a row while someone else is eligible
  - the first drawer of a rematch is never the previous drawer
- [x] Round number and total ("RD 2/5") always visible next to the player list
- [x] After each round, a results card shows the word, drawer, who guessed, points this round and totals; it auto-advances after 8s (`ROUND_RESULTS_MS`) and the host can skip
- [x] After round 5: final leaderboard with Play Again and Return to Lobby
- [x] One guarded `advance()` path for timer and host, so a match never advances twice
- [x] Rematch resets round number, scores, guessed status, results, timers and the canvas, exactly once
- [x] Changing player counts:
  - pause between rounds while fewer than 2 are connected, resuming on reconnect
  - end the match early (with standings and an explanation) when fewer than 2 remain in the room

### 2. Scoring
- [x] Guesser: `max(20, 50 − 10·(order−1)) + round(50 · timeLeft/60s)`, at most 100. Drawer: 25 per correct guesser.
- [x] Server-only: no client event carries scores, round numbers, drawer identity or correctness (forged events are ignored; tested)
- [x] At most once per player per word; points are awarded when the server accepts a guess, never when a round ends; scores are keyed by player id, so reconnects don't reset or duplicate them
- [x] Simultaneous guesses are ordered by arrival; a guess that arrives after the deadline but before the timer fires does not score

### 3. Round results and final leaderboard
- [x] Results card: word, drawer, ✓ guessers, per-player `+points` and totals (compact table, truncating names)
- [x] Leaderboard:
  - ranked list with medals for ranks 1–3
  - "Guessed N · Drew N" per player
  - tie-aware wording: "X wins!", "You win!", "It's a tie! A & B share first place", "No winner this time"
  - early-end explanation when the match ended early
- [x] Readable at 320–430px with 16-character and Devanagari nicknames; on short screens the list always shows at least two full rows

### 4. State safety (audited and tested)
- [x] Host leaving or disconnecting → hand-off; the new host has the controls and the old host doesn't
- [x] Drawer leaving during word choice or drawing → round ends (and counts); the match continues
- [x] Guesser leaving or reconnecting
- [x] Temporarily fewer than 2 players → pause; permanently fewer than 2 → match ends
- [x] Timer vs correct-guess race; simultaneous correct guesses
- [x] Repeated Next Round / Play Again (including concurrent requests over sockets) → exactly one transition
- [x] Unauthorized start, advance and rematch → `NOT_HOST`; forged score/end events → ignored
- [x] Abandoned rooms are deleted with all timers; every state change clears the timers of the state it leaves
- [x] All timer callbacks are crash-safe (errors are logged, never thrown into the event loop)
- [x] Client listeners are registered once (`startGameClient` guard); component effects clean up their intervals, listeners, and canvas renderer

### 5. Rematch and lobby
- [x] Results stay up until the host acts; Play Again needs 2+ connected players and only one rematch can start; Return to Lobby keeps everyone seated
- [x] Late joins are refused from Start until the lobby (documented); room codes, invites, seat recovery, duplicate-tab handling and host hand-off are unchanged and still pass their e2e checks

### 6. Mobile polish
- [x] Canvas stays the main element; compact scores and drawer/guessed markers in the player strip
- [x] Correct-guess feedback with points ("You guessed the word! +88"; header "You got it! +88" while others are still guessing), without revealing the word to others
- [x] States covered: rejoining/loading, disconnected banner, choosing/waiting, round results with countdown, paused, match over
- [x] No horizontal scroll at 320/360/390/430px (game, results card and leaderboard); touch drawing still never scrolls the page

### Bugs found during Phase 3 (each fixed with a regression test seen failing first)
- [x] **Answer leak through chat (from Phase 2):** a guess that *contained* the word ("maybe zebracorn?") wasn't an exact match, so it was broadcast to everyone, revealing the answer. Such messages are now visible only to the sender, the drawer and players who already guessed (labelled "hidden from guessers"), and never score.
- [x] **Offered words reused as later answers:** only the *chosen* word was marked used, so a word a previous drawer had been offered could become a later round's answer, which that player then recognized. All offered words are now marked used. (This showed up as an intermittent privacy-test failure.)
- [x] **Late guesses scoring:** a correct guess processed after the deadline, before the timer callback ran, still counted. It now ends the round first.
- [x] **Leaderboard unreadable on short phones:** at 320×568 the standings list was squeezed to zero height. It now has priority over chat and a minimum height.
- [x] **Racy Phase 2 test:** the drawing-order integration test waited for one viewer but asserted on another. Fixed by waiting for each viewer, which makes the test stricter.

## Verification performed (Phase 3)

- [x] `npm run typecheck`: clean (shared, server + tests, client + tests, Vite config)
- [x] `npm test`: **86/86** passing
  - Server, 82 tests:
    - `RoomManager.test.ts` (11): Phase 1 rooms
    - `socket.test.ts` (7): Phase 1 sockets
    - `round.test.ts` (30): Phase 2 rounds, guessing, drawing
    - `game.socket.test.ts` (5): Phase 2 sockets
    - `match.test.ts` (27): Phase 3 scoring, matches, rotation, safety, privacy; deterministic via node's mock timers
    - `match.socket.test.ts` (2): a full 5-round match over real sockets with 4 clients, including a full replay of everything a non-guessing player received to prove no word arrived before its reveal
  - Client, 4 tests: stroke board and batching
  - The server suite passed **12 consecutive runs** after the flaky-test fixes
- [x] Deliberately broken code was caught by the tests:
  - repeat answers scoring again
  - late guesses scoring
  - answer-in-message leak
  - rematch keeping old scores
  - six rounds instead of five
  - back-to-back drawer allowed
  - offered words reused
- [x] One mutation survives by design: removing the `advance()` phase guard. It is redundant defence, since every exit from round-end already cancels the timer.
- [x] `npm run build`: shared, server and client all build
- [x] `npm run test:e2e`: **27/27** headless-Chrome checks passing, on **3 consecutive runs** plus a fourth counting run. New in Phase 3:
  - a full 5-round match in two browsers (16-character and Devanagari nicknames): round counter every round, word hidden from the guesser, near-miss message hidden and unscored, results card points (+25 drawer, 50–100 guesser), results card at 320/360px, final standings sorted and matching the last totals, winner/tie text, host vs guest actions
  - leaderboard layout at 320/360/390/430/1280px with every row fully visible
  - Play Again double-tap starting exactly one clean match
  - Return to Lobby keeping both players
  - all 23 Phase 1–2 checks unchanged

## Known issues and limitations

- **Deployment prepared but not yet performed** (see Phase 4). State is in memory only: a server restart ends all games, and in dev, editing server or shared code restarts the server.
- **No late joins mid-match.** Players can join only in the lobby. A player whose seat expires mid-match must wait until the host returns to the lobby.
- **Departed players aren't ranked.** Someone who leaves (or whose seat expires) before the end disappears from the final standings, even if they were leading. Their earlier points still show in past round results.
- **The chat rate limit (5 messages per 5s) also applies to guesses.** Very fast guessers can see "slow down" and have to resend. This also slows brute-forcing the word list; there's no further anti-cheat.
- **Messages that contain the answer are hidden from guessers** by substring match, so an innocent message ("category" when the word is "cat") is occasionally hidden from guessers too. Its sender doesn't notice.
- **The word list (152) is reused** after about 50 rounds in one room.
- **Results card on very short screens:** it sits over the canvas and scrolls with 8 players on small phones. The final drawing is covered while results show.
- **Unchanged from earlier phases:** no undo; strokes drawn while offline are discarded; canvas limits per round; time-based host hand-off; per-connection (not per-IP) rate limits; no profanity filter; Google Fonts; harmless npm install-script warning.

## Untested scenarios

- **Real devices and browsers:** testing used Chrome's mobile emulation only — no real iPhone/Android, real on-screen keyboard, stylus, Firefox or Safari.
- **Full 8-player matches.** Matches were tested with 2–6 players in unit tests, 4 clients over sockets, and 2 browsers end-to-end.
- **Network conditions:** high latency, packet loss, and many rooms at once (load).
- **DPR changes after page load** (moving the window to another monitor): DevTools emulation can't fire the event this relies on.

## Next
No phase planned. Possible follow-ups: persistence across restarts, late joins, real-device testing.
