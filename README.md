# Draw & Guess

A mobile-first multiplayer drawing and guessing game for the browser.

**Current state: Phase 1 (foundation + lobby).** Players can create and join rooms, see each other in a live lobby, and the host can start the game. Drawing, guessing, scoring and rounds are **not built yet**. After the host presses Start, the screen says so plainly.

## Tech stack

| Layer  | Tools |
| ------ | ----- |
| Client | React 19, TypeScript, Vite 8, Tailwind CSS 4, socket.io-client |
| Server | Node.js, Express 5, Socket.IO 4, TypeScript (tsx in dev) |
| Shared | `@draw-guess/shared`: event contracts, types, constants, validators |

npm workspaces tie the three packages together. There's no database and no authentication. All room state lives in the server's memory.

## Requirements

- Node.js **20.12 or newer** (tested on Node 26.3, npm 11.16)

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
| `npm run typecheck` | Type-checks shared, server (including tests) and client |
| `npm test` | Server unit tests plus Socket.IO integration tests (Node's built-in test runner) |
| `npm run test:e2e` | Builds, then runs lobby flows in headless Chrome (needs Chrome and Node 22+; set `CHROME_PATH` if Chrome isn't found) |
| `npm run build` | Production build of all three packages |
| `npm start` | Runs the built server. It also serves `client/dist` on port 3001, so run `npm run build` first |

Health check: `GET /api/health` returns `{ status, uptimeSeconds, rooms, players, connections }`.

## Testing with two players

Each browser **tab** is a separate player, because seat credentials are stored in `sessionStorage`. A *duplicated* tab notices that its copied seat is already open and starts fresh on the home screen. The most reliable setup is two windows that don't share storage:

1. `npm run dev`
2. **Window A** (normal window): open <http://localhost:5173>, enter a nickname such as `Alice`, then tap **Create Room**. You land in the lobby with a 5-character room code and a crown on your name.
3. **Window B** (a private/incognito window or a different browser): either
   - paste the invite link from A (**Copy invite**) into the address bar, e.g. `http://localhost:5173/?room=K7QXP`. The code is pre-filled. Or
   - open <http://localhost:5173> and type the code. Pasting the whole invite link into the code box also works.

   Enter `Bob` and tap **Join**. Both lobbies update instantly.
4. Try the validation:
   - Join from a third window as `alice` → *"Someone in that room already has that nickname."*
   - Join with code `ZZZZZ` → *"We couldn't find a room with that code."*
   - Set `MAX_PLAYERS_PER_ROOM=2` in `.env`, restart, and join a third player → *"That room is full."*
5. Connection handling:
   - Reload window B. It rejoins the same seat automatically.
   - Stop the dev server (Ctrl+C). Both windows show a "Connection lost" banner and Start is disabled. Restart it. Because rooms live in memory, the windows return home with a "seat expired" message and the room code still filled in.
   - Close the host's window. After about 10 seconds (`HOST_HANDOFF_MS`), the host role moves to the other player.
6. In window A (the host), tap **Start Game** once 2 or more players are connected. Both windows show the "Game started" screen. Late joiners are refused. The host can tap **Back to lobby**.

### Testing on a phone

Set `DEV_HOST=0.0.0.0` in `.env`, restart `npm run dev`, and open the "Network" URL that Vite prints (e.g. `http://192.168.1.20:5173`) on a phone on the same Wi-Fi. Copy-invite falls back to a legacy copy method on plain HTTP, and the native **Share** button appears where the browser supports it.

## Configuration

All settings live in a single root `.env`, which both the server and Vite read. See [.env.example](.env.example).

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `PORT` | `3001` | Game server port (Vite proxies to it) |
| `HOST` | `0.0.0.0` | Server bind address |
| `CORS_ORIGINS` | *(empty)* | Comma-separated origins, only needed if the client is hosted on another origin |
| `MAX_PLAYERS_PER_ROOM` | `8` | Clamped to 2–8 |
| `MAX_ROOMS` | `500` | Server-wide cap on simultaneous rooms |
| `RECONNECT_GRACE_MS` | `30000` | How long a dropped player keeps their seat |
| `HOST_HANDOFF_MS` | `10000` | How long a dropped host stays host before the role moves to a connected player |
| `DEV_HOST` / `CLIENT_PORT` | `localhost` / `5173` | Vite dev server bind address and port |
| `VITE_SERVER_URL` | *(empty)* | Absolute server URL when not same-origin |

## Project structure

```
shared/src/
  constants.ts      room/nickname limits, room-code alphabet, player colors
  events.ts         ClientToServerEvents / ServerToClientEvents (the socket contract)
  types.ts          RoomSnapshot, PublicPlayer, JoinedRoom
  errors.ts         error codes + user-facing messages, AckResult<T>
  validation.ts     nickname / room-code normalization and validation
server/src/
  index.ts          bootstrap, graceful shutdown
  createApp.ts      Express + Socket.IO wiring, /api/health, static client in prod
  config.ts         env parsing (loads root .env)
  rooms/            RoomManager (pure, socket-free state machine), codes, errors
  socket/           event handlers, payload validation, per-socket rate limit
server/test/        RoomManager unit tests + real Socket.IO integration tests
e2e/                dependency-free headless-Chrome lobby tests (CDP)
client/src/
  lib/gameStore.ts  socket → store bridge (useSyncExternalStore), actions, auto-rejoin
  lib/socket.ts     typed socket singleton
  lib/storage.ts    session/nickname persistence, invite URLs
  screens/          HomeScreen, LobbyScreen, GameStartedScreen
  components/       Button, ConnectionBadge, PlayerList, Logo, Toast, Backdrop, icons
```

## Architecture notes (for later phases)

- **The server is authoritative.** The client sends intents (`room:join`, `game:start`, …). The server validates every payload as untrusted input, mutates state, and broadcasts a full `room:state` snapshot. The client never computes room state itself.
- **Every client event takes an acknowledgement** `AckResult<T>` (`{ ok: true, data } | { ok: false, error: { code, message } }`). The server drops events that arrive without one.
- **Players have stable IDs, separate from socket IDs.** A secret `sessionToken` lets a player reclaim their seat after a reload or a dropped connection (`room:rejoin`). Disconnected players keep their seat for `RECONNECT_GRACE_MS`. If the host leaves, or stays disconnected longer than `HOST_HANDOFF_MS`, the longest-standing connected player becomes host.
- **`RoomManager` has no Socket.IO dependency.** Game logic for Phase 2 (turns, words, timers, scores) can be added there and unit-tested directly. `RoomPhase` is currently `'lobby' | 'in-game'`, and `GameStartedScreen` is the placeholder that the real game screen will replace.
- To add an event: declare it in `shared/src/events.ts`, handle it in `server/src/socket/registerHandlers.ts`, and add an action in `client/src/lib/gameStore.ts`.
