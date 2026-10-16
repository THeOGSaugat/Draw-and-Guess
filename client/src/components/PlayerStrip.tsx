import type { RoomSnapshot } from '@draw-guess/shared';
import { CheckIcon, PencilIcon } from './icons';
import { PlayerAvatar } from './PlayerList';

/** Round counter plus a compact, horizontally scrollable player list with scores. */
export function PlayerStrip({ room, selfId }: { room: RoomSnapshot; selfId: string }) {
  const round = room.round;
  const match = room.match;
  const scoreOf = (id: string) => match?.standings.find((s) => s.playerId === id)?.score ?? 0;
  return (
    <div className="flex items-center gap-1.5">
      {match && room.phase !== 'match-end' && (
        <p
          aria-label={`Round ${match.roundNumber} of ${match.totalRounds}`}
          className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-grape/40 bg-grape/15 px-2.5 font-display text-sm font-bold text-white"
        >
          <span className="text-[0.65rem] font-extrabold tracking-wider text-grape uppercase">Rd</span>
          <span className="tabular-nums">
            {match.roundNumber}
            <span className="text-slate-400">/{match.totalRounds}</span>
          </span>
        </p>
      )}
      <ul className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto overscroll-x-contain pb-0.5 [scrollbar-width:none]" aria-label="Players">
        {room.players.map((p) => {
          const drawing = round?.drawerId === p.id;
          const guessed = round?.guessedIds.includes(p.id) ?? false;
          const status = drawing ? 'drawing' : guessed ? 'guessed the word' : p.connected ? 'guessing' : 'reconnecting';
          const score = match ? `, ${scoreOf(p.id)} points` : '';
          return (
            <li
              key={p.id}
              aria-label={`${p.id === selfId ? 'You' : p.nickname}${p.isHost ? ', host' : ''}, ${status}${score}`}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border py-0.5 pr-2.5 pl-0.5 text-sm font-bold ${
                guessed ? 'border-mint/40 bg-mint/10' : drawing ? 'border-sun/40 bg-sun/10' : 'border-white/10 bg-navy-900/70'
              } ${p.connected ? '' : 'opacity-50'}`}
            >
              <PlayerAvatar player={p} size="sm" />
              <span className="max-w-[6.5rem] truncate">{p.id === selfId ? 'You' : p.nickname}</span>
              {drawing && <PencilIcon className="shrink-0 text-sun" />}
              {guessed && <CheckIcon className="shrink-0 text-mint" />}
              {match && (
                <span className="shrink-0 rounded-full bg-white/10 px-1.5 font-display text-xs tabular-nums text-slate-200">
                  {scoreOf(p.id)}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
