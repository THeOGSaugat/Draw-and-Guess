import { useState, type ReactNode } from 'react';
import type { PrivateRoundInfo, RoomSnapshot, RoundEndReason } from '@draw-guess/shared';
import { chooseWord, nextRound, notify } from '../lib/gameStore';
import { useCountdown } from '../lib/useCountdown';
import { Button } from './Button';
import { CheckIcon, PencilIcon, PlayIcon } from './icons';

const END_REASON: Record<RoundEndReason, string> = {
  timeout: "Time's up!",
  'all-guessed': 'Everyone guessed it!',
  'drawer-left': 'The drawer left the game.',
  'not-enough-players': 'Not enough players left.',
};

function Card({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="absolute inset-0 z-10 grid place-items-center overflow-y-auto bg-navy-950/70 p-3 backdrop-blur-[2px]">
      <section
        aria-label={label}
        className="panel w-full max-w-sm animate-pop-in p-4 text-center sm:p-5"
      >
        {children}
      </section>
    </div>
  );
}

interface RoundOverlayProps {
  room: RoomSnapshot;
  selfId: string;
  privateRound: PrivateRoundInfo | null;
  /** When round results give way to the next round (local ms). */
  advanceDeadline: number | null;
}

/** Word choice, "someone is choosing", and the end-of-round reveal, layered over the canvas. */
export function RoundOverlay({ room, selfId, privateRound, advanceDeadline }: RoundOverlayProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const seconds = useCountdown(room.phase === 'round-end' ? advanceDeadline : null);
  const round = room.round;
  if (!round) return null;
  const isDrawer = round.drawerId === selfId;
  const isHost = room.hostId === selfId;
  const drawer = room.players.find((p) => p.id === round.drawerId);
  const host = room.players.find((p) => p.isHost);

  async function run(key: string, action: () => Promise<{ ok: boolean; error?: { message: string } }>) {
    setBusy(key);
    const result = await action();
    setBusy(null);
    if (!result.ok && result.error) notify('error', result.error.message);
  }

  if (room.phase === 'choosing') {
    if (isDrawer && privateRound?.choices) {
      return (
        <Card label="Choose a word">
          <PencilIcon className="mx-auto text-3xl text-sun" />
          <h2 className="mt-1 font-display text-xl font-semibold text-white">Pick a word to draw</h2>
          <p className="text-xs font-semibold text-slate-400">Only you can see these.</p>
          <div className="mt-3 flex flex-col gap-2">
            {privateRound.choices.map((word, i) => (
              <Button
                key={word}
                variant={i === 0 ? 'primary' : 'secondary'}
                loading={busy === word}
                disabled={busy !== null}
                onClick={() => run(word, () => chooseWord(i))}
              >
                {word}
              </Button>
            ))}
          </div>
        </Card>
      );
    }
    return (
      <Card label="Waiting for the drawer">
        <PencilIcon className="mx-auto animate-wiggle text-3xl text-sun" />
        <p className="mt-2 font-display text-lg font-semibold text-white">
          <span className="inline-block max-w-full truncate align-bottom">{drawer?.nickname ?? 'The drawer'}</span> is
          choosing a word…
        </p>
      </Card>
    );
  }

  if (room.phase !== 'round-end') return null;
  const match = room.match;
  const result = match?.lastResult ?? null;
  const isLast = match ? match.roundNumber >= match.totalRounds : false;
  const connected = room.players.filter((p) => p.connected).length;
  const rows = result ? [...result.entries].sort((a, b) => b.points - a.points || b.total - a.total) : [];

  return (
    <Card label="Round results">
      <p className="text-xs font-extrabold tracking-[0.2em] text-slate-400 uppercase">
        Round {round.number} of {match?.totalRounds ?? round.number} ·{' '}
        {round.endReason ? END_REASON[round.endReason] : 'Round over'}
      </p>
      {round.word ? (
        <p className="mt-1 text-sm font-semibold text-slate-300">
          The word was <span className="block font-display text-3xl font-bold break-words text-sun">{round.word}</span>
        </p>
      ) : (
        <p className="mt-1 font-display text-xl font-semibold text-white">Round cancelled</p>
      )}
      {result && (
        <p className="mt-0.5 truncate text-xs font-bold text-slate-400">
          Drawn by {result.drawerId === selfId ? 'you' : result.drawerNickname}
        </p>
      )}

      {rows.length > 0 && (
        <table className="mt-3 w-full table-fixed text-left text-sm">
          <caption className="sr-only">Points this round and total scores</caption>
          <thead className="text-[0.7rem] font-extrabold tracking-wider text-slate-500 uppercase">
            <tr>
              <th scope="col" className="pb-1 font-extrabold">
                Player
              </th>
              <th scope="col" className="w-14 pb-1 text-right font-extrabold">
                Round
              </th>
              <th scope="col" className="w-14 pb-1 text-right font-extrabold">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.playerId} className={e.playerId === selfId ? 'bg-sky/10' : ''}>
                <td className="py-1 pl-1">
                  <span className="flex min-w-0 items-center gap-1.5 font-bold text-slate-100">
                    {e.isDrawer ? (
                      <PencilIcon className="shrink-0 text-sun" aria-label="Drawer" />
                    ) : e.guessed ? (
                      <CheckIcon className="shrink-0 text-mint" aria-label="Guessed" />
                    ) : (
                      <span className="w-[1em] shrink-0" />
                    )}
                    <span className="truncate">{e.playerId === selfId ? 'You' : e.nickname}</span>
                  </span>
                </td>
                <td className={`py-1 text-right font-display font-bold tabular-nums ${e.points > 0 ? 'text-mint' : 'text-slate-500'}`}>
                  +{e.points}
                </td>
                <td className="py-1 pr-1 text-right font-display font-bold text-white tabular-nums">{e.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {match?.waitingForPlayers ? (
        <p role="status" className="mt-3 rounded-xl bg-candy/10 px-3 py-2 text-xs font-bold text-pink-100">
          Paused: waiting for players to reconnect (need {room.minPlayers}).
        </p>
      ) : (
        seconds !== null && (
          <p className="mt-3 text-xs font-bold text-slate-400" aria-live="off">
            {isLast ? 'Final results' : `Round ${round.number + 1}`} in {seconds}s
          </p>
        )
      )}
      {isHost ? (
        <div className="mt-2 flex flex-col gap-2">
          <Button
            icon={<PlayIcon />}
            loading={busy === 'next'}
            disabled={busy !== null || (!isLast && connected < room.minPlayers)}
            onClick={() => run('next', nextRound)}
          >
            {isLast ? 'See final results' : 'Next round'}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs font-semibold text-slate-500">
          <span className="inline-block max-w-[10rem] truncate align-bottom">{host?.nickname ?? 'The host'}</span> can skip
          ahead.
        </p>
      )}
    </Card>
  );
}
