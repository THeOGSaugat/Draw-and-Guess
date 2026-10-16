import { useState } from 'react';
import type { RoomSnapshot } from '@draw-guess/shared';
import { Button } from '../components/Button';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { ExitIcon, PencilIcon } from '../components/icons';
import { Logo } from '../components/Logo';
import { PlayerAvatar } from '../components/PlayerList';
import { leaveRoom, notify, returnToLobby, type ConnectionStatus } from '../lib/gameStore';

interface GameStartedScreenProps {
  room: RoomSnapshot;
  playerId: string;
  connection: ConnectionStatus;
}

/**
 * Shown once the host starts. The server really has moved the room out of the
 * lobby (new joins are refused), but drawing/guessing rounds are not built yet,
 * and this screen says so plainly instead of faking gameplay.
 */
export function GameStartedScreen({ room, playerId, connection }: GameStartedScreenProps) {
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const isHost = room.hostId === playerId;

  async function handleBackToLobby() {
    setBusy(true);
    const result = await returnToLobby();
    setBusy(false);
    if (!result.ok) notify('error', result.error.message);
  }

  return (
    <main className="safe-px mx-auto flex min-h-dvh w-full max-w-md flex-col pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex items-center justify-between gap-3">
        <Logo size="sm" />
        <ConnectionBadge status={connection} compact />
      </header>

      <section className="panel mt-8 animate-pop-in p-6 text-center">
        <div className="mx-auto grid size-16 animate-wiggle place-items-center rounded-2xl bg-sun text-4xl text-navy-950">
          <PencilIcon />
        </div>
        <h2 className="mt-4 font-display text-3xl font-bold text-white">Game started!</h2>
        <p className="mt-2 text-sm font-semibold text-slate-300">
          Room <span className="font-display tracking-widest text-sky">{room.code}</span> is locked — no new players can
          join.
        </p>
        <p className="mt-4 rounded-2xl bg-white/5 px-4 py-3 text-sm font-semibold text-slate-300">
          Drawing and guessing rounds aren't built yet (coming in Phase 2), so there's nothing to play here for now.
        </p>

        <ul className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Players">
          {room.players.map((p) => (
            <li key={p.id} className="flex items-center gap-2 rounded-full bg-navy-900/80 py-1 pr-3 pl-1">
              <PlayerAvatar player={p} size="sm" />
              <span className="max-w-28 truncate text-sm font-bold">{p.nickname}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-auto flex flex-col gap-3 pt-8">
        {isHost ? (
          <Button size="lg" variant="secondary" loading={busy} onClick={handleBackToLobby}>
            Back to lobby
          </Button>
        ) : (
          <p className="text-center text-sm font-semibold text-slate-400">The host can send everyone back to the lobby.</p>
        )}
        <Button
          variant="ghost"
          icon={<ExitIcon />}
          loading={leaving}
          onClick={() => {
            setLeaving(true);
            void leaveRoom();
          }}
        >
          Leave room
        </Button>
      </div>
    </main>
  );
}
