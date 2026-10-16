import { useEffect, useRef, useState } from 'react';
import type { RoomSnapshot } from '@draw-guess/shared';
import { Button } from '../components/Button';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { CheckIcon, CopyIcon, ExitIcon, LinkIcon, PlayIcon, ShareIcon, UsersIcon } from '../components/icons';
import { Logo } from '../components/Logo';
import { PlayerList } from '../components/PlayerList';
import { canNativeShare, copyText } from '../lib/clipboard';
import { leaveRoom, notify, startGame, type ConnectionStatus } from '../lib/gameStore';
import { buildInviteUrl } from '../lib/storage';

interface LobbyScreenProps {
  room: RoomSnapshot;
  playerId: string;
  connection: ConnectionStatus;
}

type CopyTarget = 'code' | 'link';

export function LobbyScreen({ room, playerId, connection }: LobbyScreenProps) {
  const [copied, setCopied] = useState<CopyTarget | null>(null);
  const [starting, setStarting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const inviteUrl = buildInviteUrl(room.code);
  const isHost = room.hostId === playerId;
  const host = room.players.find((p) => p.isHost);
  const connectedCount = room.players.filter((p) => p.connected).length;
  const enoughPlayers = connectedCount >= room.minPlayers;
  const online = connection === 'connected';

  async function copy(target: CopyTarget) {
    const ok = await copyText(target === 'code' ? room.code : inviteUrl);
    if (!ok) {
      notify('error', "Couldn't copy automatically — long-press the text to copy it.");
      return;
    }
    setCopied(target);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(null), 2000);
  }

  async function share() {
    try {
      await navigator.share({
        title: 'Draw & Guess',
        text: `Join my Draw & Guess room! Code: ${room.code}`,
        url: inviteUrl,
      });
    } catch {
      // User dismissed the share sheet; nothing to do.
    }
  }

  async function handleStart() {
    setStarting(true);
    const result = await startGame();
    setStarting(false);
    if (!result.ok) notify('error', result.error.message);
  }

  async function handleLeave() {
    setLeaving(true);
    await leaveRoom();
  }

  return (
    <main className="safe-px mx-auto flex min-h-dvh w-full max-w-md flex-col pt-[max(1rem,env(safe-area-inset-top))] md:max-w-4xl">
      <header className="flex items-center justify-between gap-3">
        <Logo size="sm" />
        <div className="flex items-center gap-2">
          <ConnectionBadge status={connection} compact />
          <Button
            variant="ghost"
            className="min-h-9! rounded-full! px-3! text-sm!"
            icon={<ExitIcon />}
            loading={leaving}
            onClick={handleLeave}
            aria-label="Leave room"
          >
            <span className="hidden sm:inline">Leave</span>
          </Button>
        </div>
      </header>

      {connection !== 'connected' && (
        <div className="mt-4 animate-pop-in rounded-2xl border border-candy/30 bg-[#2a1233] px-4 py-3 text-sm font-bold text-pink-100">
          Connection lost — reconnecting. Your seat is held for a short while.
        </div>
      )}

      <div className={`mt-5 grid flex-1 grid-cols-1 content-start gap-4 transition-opacity ${online ? '' : 'opacity-60'} md:flex-none md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] md:items-start md:gap-6`}>
        <section className="panel animate-fade-up p-5 sm:p-6" aria-labelledby="room-code-heading">
          <h2
            id="room-code-heading"
            className="text-center text-xs font-extrabold tracking-[0.25em] text-slate-400 uppercase"
          >
            Room code
          </h2>
          <button
            type="button"
            onClick={() => copy('code')}
            className="group mx-auto mt-3 flex w-full justify-center gap-1.5 sm:gap-2"
            aria-label={`Room code ${room.code.split('').join(' ')}. Tap to copy.`}
          >
            {room.code.split('').map((char, i) => (
              <span
                key={i}
                className="grid aspect-[4/5] w-full max-w-14 animate-pop-in place-items-center rounded-2xl border-2 border-white/10 bg-navy-900 font-display text-3xl font-bold text-white shadow-[inset_0_-4px_0_rgb(0_0_0/0.3)] transition-colors group-hover:border-sky/50 sm:text-4xl"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {char}
              </span>
            ))}
          </button>
          <p className="mt-2 h-5 text-center text-xs font-bold text-slate-400">
            {copied === 'code' ? <span className="text-mint">Code copied!</span> : 'Tap the code to copy it'}
          </p>

          <div className="mt-4 flex min-w-0 items-center gap-2 rounded-2xl bg-navy-900/80 px-3 py-2.5 text-sm text-slate-300">
            <LinkIcon className="shrink-0 text-sky" />
            <span className="truncate font-semibold" title={inviteUrl}>
              {inviteUrl.replace(/^https?:\/\//, '')}
            </span>
          </div>

          <div className="mt-3 flex gap-2.5">
            <Button
              variant="secondary"
              className="flex-1"
              icon={copied === 'link' ? <CheckIcon /> : <CopyIcon />}
              onClick={() => copy('link')}
            >
              {copied === 'link' ? 'Link copied!' : 'Copy invite'}
            </Button>
            {canNativeShare() && (
              <Button variant="ghost" icon={<ShareIcon />} onClick={share} aria-label="Share invite link">
                <span className="hidden min-[380px]:inline">Share</span>
              </Button>
            )}
          </div>
        </section>

        <section className="panel animate-fade-up p-5 [animation-delay:80ms] sm:p-6" aria-labelledby="players-heading">
          <div className="mb-4 flex items-center justify-between">
            <h2 id="players-heading" className="flex items-center gap-2 font-display text-xl font-semibold text-white">
              <UsersIcon className="text-grape" />
              Players
            </h2>
            <span className="rounded-full bg-white/5 px-3 py-1 font-display text-sm font-semibold text-slate-300">
              {room.players.length}/{room.maxPlayers}
            </span>
          </div>
          <PlayerList players={room.players} selfId={playerId} maxPlayers={room.maxPlayers} />
        </section>
      </div>

      <footer className="sticky bottom-0 -mx-4 mt-4 bg-gradient-to-t from-navy-950 via-navy-950/95 to-transparent px-4 pt-6 pb-[max(1rem,env(safe-area-inset-bottom))] md:static md:mx-auto md:w-full md:max-w-sm md:bg-none md:pt-6">
        {isHost ? (
          <>
            <Button
              size="lg"
              className="w-full"
              icon={<PlayIcon />}
              loading={starting}
              disabled={!enoughPlayers || !online}
              onClick={handleStart}
            >
              Start Game
            </Button>
            <p className="mt-2 text-center text-xs font-bold text-slate-400">
              {enoughPlayers
                ? `${connectedCount} players ready — you're the host!`
                : `Waiting for at least ${room.minPlayers} connected players…`}
            </p>
          </>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-navy-800/90 px-4 py-4 text-center">
            <p className="font-display text-lg font-semibold text-white">
              Waiting for {host?.nickname ?? 'the host'} to start
              <span className="inline-flex w-6 justify-start">
                <span className="animate-pulse">…</span>
              </span>
            </p>
            <p className="text-xs font-bold text-slate-400">
              {host && !host.connected
                ? 'The host lost connection. If they don’t return soon, the next player becomes host.'
                : enoughPlayers
                  ? 'Everyone can see you in the lobby.'
                  : `Need ${room.minPlayers}+ players to begin.`}
            </p>
          </div>
        )}
      </footer>
    </main>
  );
}
