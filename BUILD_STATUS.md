# Build Status

_Last updated: 2026-10-16. Phase 1: Foundation + Mobile UI, plus a bug-fix pass._

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
- [x] Start Game really changes server state: the room enters `in-game` and new joins are refused. The host can return everyone to the lobby.
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

### Verification performed
- [x] `npm run typecheck`: clean (shared, server and tests, client and Vite config)
- [x] `npm test`: 18/18 passing (11 RoomManager unit tests, 7 Socket.IO integration tests against a real server)
- [x] `npm run test:e2e`: 12/12 headless-Chrome checks passing (create; invite link; duplicate nickname; Devanagari nickname; pasted link; unknown room; reload restore; duplicated tab; overflow at 320/390/768/1280px; start/late-join/back to lobby; host hand-off; server outage and recovery). Breaking the duplicate-tab and paste fixes on purpose made those checks fail, so the tests can catch regressions.
- [x] `npm run build`: shared, server and client all build
- [x] `npm run dev`: all three processes start; health endpoint works directly and through the Vite proxy
- [x] `npm start`: serves the client, assets, `/api/health` and Socket.IO from one port

## Known issues and limitations

- **Gameplay isn't implemented yet.** After Start Game, players see a "Game started" screen that says drawing and guessing come in Phase 2. Nothing is simulated.
- **State is in memory only.** Restarting the server drops every room; clients then return home with a "seat expired" message. One server process only: scaling out would need a Socket.IO adapter and shared storage.
- **Host hand-off is time-based.** A host whose phone sleeps for more than 10s (e.g. while sharing the invite in another app) loses the host role and comes back as a regular player. Raise `HOST_HANDOFF_MS` if that's a problem.
- **Rate limiting is per connection**, not per IP. There's no profanity filter on nicknames.
- **Duplicate-tab detection** needs `BroadcastChannel` (all current browsers). If the original tab is itself mid-reconnect when the duplicate opens, neither can answer, and the most recent tab keeps the seat; the other is told and returns home.
- **Fonts come from Google Fonts.** Offline, the UI falls back to system fonts.
- **Clipboard and Share on plain HTTP:** on LAN URLs like `http://192.168.x.x`, copying uses a legacy fallback, and the Share button appears only where the browser supports `navigator.share`.
- **Install-script warning:** npm 11 blocks install scripts by default and lists `esbuild` and `fsevents`. Neither is needed; esbuild's binary comes from an optional dependency, and everything was verified with the scripts blocked.
- **The e2e suite needs a local Chrome** (or `CHROME_PATH`) and Node 22+ (for the built-in `WebSocket`). It's dependency-free by design. Move to Playwright if cross-browser runs or CI are needed.

## Next: Phase 2 (not started)
Drawing canvas, word selection, guessing and chat, scoring, round progression and timers.
