import { useState } from 'react';
import type { RoomSnapshot } from '@draw-guess/shared';
import { notify, playAgain, returnToLobby } from '../lib/gameStore';
import { Button } from './Button';
import { PlayIcon } from './icons';
import { PlayerAvatar } from './PlayerList';

const ordinal = (n: number) => {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
};

const MEDAL: Record<number, string> = {
  1: 'bg-sun text-navy-950',
  2: 'bg-slate-300 text-navy-950',
  3: 'bg-tangerine text-navy-950',
};

/** Final standings after the match, with tie-aware winner text and host actions. */
export function FinalLeaderboard({ room, selfId }: { room: RoomSnapshot; selfId: string }) {
  const [busy, setBusy] = useState<'again' | 'lobby' | null>(null);
  const match = room.match;
  if (!match) return null;
  const isHost = room.hostId === selfId;
  const host = room.players.find((p) => p.isHost);
  const connected = room.players.filter((p) => p.connected).length;
  const name = (id: string) => (id === selfId ? 'You' : (match.standings.find((s) => s.playerId === id)?.nickname ?? '?'));
  const winners = match.winnerIds;

  let title: string;
  let subtitle: string | null = null;
  if (winners.length === 1) {
    title = winners[0] === selfId ? 'You win!' : `${name(winners[0]!)} wins!`;
  } else if (winners.length > 1) {
    title = "It's a tie!";
    subtitle = `${winners.map(name).join(' & ')} share first place.`;
  } else {
    title = 'No winner this time';
    subtitle = 'Nobody scored any points.';
  }

  async function run(key: 'again' | 'lobby', action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(key);
    const result = await action();
    setBusy(null);
    if (!result.ok && result.error) notify('error', result.error.message);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* On very short screens the whole panel scrolls; the list always keeps room for at least two rows. */}
      <section
        aria-label="Final results"
        className="panel flex min-h-0 flex-1 animate-pop-in flex-col overflow-y-auto overscroll-contain p-3 sm:p-5"
      >
        <p className="text-center text-xs font-extrabold tracking-[0.2em] text-slate-400 uppercase">
          {match.endReason === 'not-enough-players' ? 'Match ended early' : `Match over · ${match.totalRounds} rounds`}
        </p>
        <h2 className="mt-0.5 text-center font-display text-2xl font-bold break-words text-sun sm:text-3xl">{title}</h2>
        {subtitle && <p className="text-center text-sm font-semibold break-words text-slate-300">{subtitle}</p>}
        {match.endReason === 'not-enough-players' && (
          <p className="mt-1 text-center text-xs font-bold text-slate-400">
            Not enough players to continue. Scores are from the {match.roundNumber} round
            {match.roundNumber === 1 ? '' : 's'} played.
          </p>
        )}

        <ol
          aria-label="Final standings"
          className="mt-2 flex min-h-[7.25rem] flex-1 shrink-0 flex-col gap-1.5 overflow-y-auto overscroll-contain"
        >
          {match.standings.map((s) => {
            const player = room.players.find((p) => p.id === s.playerId);
            const self = s.playerId === selfId;
            return (
              <li
                key={s.playerId}
                aria-label={`${ordinal(s.rank)} place: ${self ? 'You' : s.nickname}, ${s.score} points, guessed ${s.roundsGuessed} round${s.roundsGuessed === 1 ? '' : 's'}`}
                className={`flex items-center gap-2.5 rounded-2xl border p-2 ${
                  self ? 'border-sky/40 bg-sky/10' : 'border-white/5 bg-navy-900/60'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`grid size-8 shrink-0 place-items-center rounded-full font-display text-sm font-bold ${
                    MEDAL[s.rank] ?? 'bg-white/10 text-slate-300'
                  }`}
                >
                  {s.rank}
                </span>
                {player && <PlayerAvatar player={player} size="sm" />}
                <span aria-hidden="true" className="min-w-0 flex-1">
                  <span className="block truncate font-display text-base font-semibold text-white">
                    {self ? 'You' : s.nickname}
                  </span>
                  <span className="block truncate text-xs font-semibold text-slate-400">
                    Guessed {s.roundsGuessed} · Drew {s.roundsDrawn}
                  </span>
                </span>
                <span aria-hidden="true" className="shrink-0 font-display text-xl font-bold text-white tabular-nums">
                  {s.score}
                </span>
              </li>
            );
          })}
        </ol>

        <div className="mt-2 flex shrink-0 flex-col gap-2">
          {isHost ? (
            <>
              <Button
                icon={<PlayIcon />}
                loading={busy === 'again'}
                disabled={busy !== null || connected < room.minPlayers}
                onClick={() => run('again', playAgain)}
              >
                Play Again
              </Button>
              {connected < room.minPlayers && (
                <p className="text-center text-xs font-bold text-slate-400">
                  Need {room.minPlayers}+ connected players to play again.
                </p>
              )}
              <Button variant="ghost" loading={busy === 'lobby'} disabled={busy !== null} onClick={() => run('lobby', returnToLobby)}>
                Return to Lobby
              </Button>
            </>
          ) : (
            <p className="text-center text-sm font-semibold text-slate-400">
              Waiting for <span className="inline-block max-w-[9rem] truncate align-bottom">{host?.nickname ?? 'the host'}</span>{' '}
              to play again or return to the lobby…
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
