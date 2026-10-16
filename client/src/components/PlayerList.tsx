import type { PublicPlayer } from '@draw-guess/shared';
import { CrownIcon, PlusIcon } from './icons';

function initial(nickname: string): string {
  return [...nickname][0]?.toUpperCase() ?? '?';
}

export function PlayerAvatar({ player, size = 'md' }: { player: PublicPlayer; size?: 'sm' | 'md' }) {
  return (
    <div
      className={`relative grid shrink-0 place-items-center rounded-2xl font-display font-bold text-navy-950 shadow-[inset_0_-4px_0_rgb(0_0_0/0.2)] ${
        size === 'md' ? 'size-12 text-xl' : 'size-9 text-base'
      }`}
      style={{ backgroundColor: player.color }}
    >
      {initial(player.nickname)}
      <span
        className={`absolute -right-1 -bottom-1 size-3.5 rounded-full border-2 border-navy-800 ${
          player.connected ? 'bg-mint' : 'bg-slate-500'
        }`}
        title={player.connected ? 'Connected' : 'Disconnected'}
      />
    </div>
  );
}

interface PlayerListProps {
  players: PublicPlayer[];
  selfId: string;
  maxPlayers: number;
}

export function PlayerList({ players, selfId, maxPlayers }: PlayerListProps) {
  const openSeats = Math.max(0, maxPlayers - players.length);
  return (
    <ul className="flex flex-col gap-2.5">
      {players.map((player) => {
        const isSelf = player.id === selfId;
        return (
          <li
            key={player.id}
            className={`flex animate-pop-in items-center gap-3 rounded-2xl border p-2.5 pr-3 transition-opacity ${
              isSelf ? 'border-sky/40 bg-sky/10' : 'border-white/5 bg-navy-900/60'
            } ${player.connected ? '' : 'opacity-60'}`}
          >
            <PlayerAvatar player={player} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-lg font-semibold text-white">{player.nickname}</p>
              <p className="truncate text-xs font-semibold text-slate-400">
                {player.connected ? 'In the lobby' : 'Reconnecting…'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {isSelf && (
                <span className="hidden rounded-full bg-sky/20 px-2 py-0.5 text-xs font-extrabold text-sky min-[380px]:inline">
                  You
                </span>
              )}
              {player.isHost && (
                <span className="inline-flex items-center gap-1 rounded-full bg-sun/15 px-2 py-0.5 text-xs font-extrabold text-sun">
                  <CrownIcon className="text-sm" aria-label="Host" />
                  <span className="hidden min-[380px]:inline">Host</span>
                </span>
              )}
            </div>
          </li>
        );
      })}
      {openSeats > 0 && (
        <li className="flex items-center gap-3 rounded-2xl border-2 border-dashed border-white/10 p-2.5 text-slate-400">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-white/5 text-xl">
            <PlusIcon />
          </div>
          <p className="text-sm font-semibold">
            {openSeats} open {openSeats === 1 ? 'seat' : 'seats'} — invite your friends!
          </p>
        </li>
      )}
    </ul>
  );
}
