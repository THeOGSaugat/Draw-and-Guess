import { Backdrop } from './components/Backdrop';
import { SpinnerIcon } from './components/icons';
import { Logo } from './components/Logo';
import { Toast } from './components/Toast';
import { Button } from './components/Button';
import { abandonSavedSession, useGame } from './lib/gameStore';
import { useSlowConnect } from './lib/useSlowConnect';
import { GameScreen } from './screens/GameScreen';
import { HomeScreen } from './screens/HomeScreen';
import { LobbyScreen } from './screens/LobbyScreen';

export function App() {
  const { connection, room, playerId, restoring, notice } = useGame();
  const slowConnect = useSlowConnect(connection === 'connected');

  let screen;
  if (room && playerId) {
    screen =
      room.phase === 'lobby' ? (
        <LobbyScreen room={room} playerId={playerId} connection={connection} />
      ) : (
        <GameScreen room={room} playerId={playerId} connection={connection} />
      );
  } else if (restoring) {
    screen = (
      <main className="grid min-h-dvh place-items-center px-4">
        <div className="flex flex-col items-center gap-6">
          <Logo />
          <p className="flex items-center gap-2 font-semibold text-slate-300">
            <SpinnerIcon /> {connection === 'connected' ? 'Rejoining your room…' : 'Connecting to the game server…'}
          </p>
          {slowConnect && (
            <p className="max-w-xs text-center text-xs font-semibold text-slate-500">
              The server may be waking up after a quiet spell. This can take up to a minute.
            </p>
          )}
          <Button variant="ghost" onClick={abandonSavedSession}>
            Back to home
          </Button>
        </div>
      </main>
    );
  } else {
    screen = <HomeScreen connection={connection} />;
  }

  return (
    <>
      <Backdrop />
      <Toast notice={notice} />
      {screen}
    </>
  );
}
