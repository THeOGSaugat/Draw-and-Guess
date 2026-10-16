import { useState } from 'react';
import { BRUSH_COLORS, BRUSH_SIZES, type DrawTool, type RoomSnapshot } from '@draw-guess/shared';
import { ChatPanel } from '../components/ChatPanel';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { DrawingCanvas } from '../components/DrawingCanvas';
import { DrawingToolbar } from '../components/DrawingToolbar';
import { FinalLeaderboard } from '../components/FinalLeaderboard';
import { GameMenu } from '../components/GameMenu';
import { CheckIcon } from '../components/icons';
import { PlayerStrip } from '../components/PlayerStrip';
import { RoundOverlay } from '../components/RoundOverlay';
import { RoundTimer } from '../components/RoundTimer';
import { clearCanvas, currentPrivateRound, notify, sendChat, useGame, type ConnectionStatus } from '../lib/gameStore';
import { useGameViewport } from '../lib/useGameViewport';

interface GameScreenProps {
  room: RoomSnapshot;
  playerId: string;
  connection: ConnectionStatus;
}

/** Renders "___ _____" as separate letter slots, with a screen-reader friendly description. */
function Hint({ hint }: { hint: string }) {
  const lengths = hint.split(/[\s-]+/).map((w) => w.length);
  return (
    <span className="flex min-w-0 flex-col items-center">
      <span aria-hidden="true" className="flex max-w-full items-end gap-[0.2rem] overflow-hidden py-1">
        {[...hint].map((ch, i) =>
          ch === '_' ? (
            <span key={i} className="h-1 w-[clamp(0.55rem,3vw,0.9rem)] shrink-0 rounded-full bg-white" />
          ) : ch === '-' ? (
            <span key={i} className="shrink-0 font-display text-sm leading-none font-bold text-white">-</span>
          ) : (
            <span key={i} className="w-2 shrink-0" />
          ),
        )}
      </span>
      <span className="text-[0.7rem] font-bold text-slate-400">
        {lengths.length > 1 ? `${lengths.join(' + ')} letters` : `${lengths[0]} letters`}
      </span>
    </span>
  );
}

export function GameScreen({ room, playerId, connection }: GameScreenProps) {
  useGameViewport();
  const game = useGame();
  const [tool, setTool] = useState<DrawTool>('pen');
  const [color, setColor] = useState<string>(BRUSH_COLORS[0].value);
  const [size, setSize] = useState<number>(BRUSH_SIZES[1].value);

  const round = room.round;
  const phase = room.phase;
  const online = connection === 'connected';
  const isDrawer = round?.drawerId === playerId;
  const hasGuessed = round?.guessedIds.includes(playerId) ?? false;
  const privateRound = currentPrivateRound(game);
  const drawer = room.players.find((p) => p.id === round?.drawerId);
  const drawerActive = isDrawer && phase === 'drawing';
  const matchOver = phase === 'match-end';
  const myRoundPoints = round?.points[playerId] ?? 0;

  let headline;
  if (phase === 'choosing') {
    headline = (
      <span className="truncate font-display text-base font-semibold text-slate-200">
        {isDrawer ? 'Pick your word' : `${drawer?.nickname ?? 'Drawer'} is choosing…`}
      </span>
    );
  } else if (phase === 'drawing') {
    if ((isDrawer || hasGuessed) && privateRound?.word) {
      headline = (
        <span className="flex min-w-0 flex-col items-center">
          <span className="max-w-full truncate font-display text-xl font-bold text-sun">{privateRound.word}</span>
          <span className="flex items-center gap-1 text-[0.7rem] font-bold text-slate-400">
            {isDrawer ? (
              'Draw this word'
            ) : (
              <>
                <CheckIcon className="text-mint" /> You got it! +{myRoundPoints}
              </>
            )}
          </span>
        </span>
      );
    } else if (round?.hint) {
      headline = <Hint hint={round.hint} />;
    }
  } else if (matchOver) {
    headline = <span className="font-display text-base font-semibold text-slate-200">Final results</span>;
  } else {
    headline = <span className="font-display text-base font-semibold text-slate-200">Round over</span>;
  }

  let chatInput: { placeholder: string; label: string } | null = { placeholder: 'Chat…', label: 'Chat message' };
  if (isDrawer && (phase === 'choosing' || phase === 'drawing')) chatInput = null;
  else if (phase === 'drawing' && !hasGuessed) chatInput = { placeholder: 'Type your guess…', label: 'Your guess' };
  else if (phase === 'drawing' && hasGuessed) {
    chatInput = { placeholder: 'Chat with players who guessed…', label: 'Message to players who guessed' };
  }

  async function handleSend(text: string): Promise<string | null> {
    const result = await sendChat(text);
    return result.ok ? null : result.error.message;
  }

  async function handleClear() {
    const result = await clearCanvas();
    if (!result.ok) notify('error', result.error.message);
  }

  return (
    <main
      className="fixed inset-x-0 flex flex-col overflow-hidden"
      style={{ top: 'var(--app-top, 0px)', height: 'var(--app-height, 100dvh)' }}
    >
      <div className="safe-px mx-auto flex h-full min-h-0 w-full max-w-xl flex-col gap-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-[max(0.5rem,env(safe-area-inset-bottom))] wide:max-w-6xl">
        <header className="flex shrink-0 items-center gap-2">
          <GameMenu isHost={room.hostId === playerId} />
          <div className="flex min-w-0 flex-1 justify-center text-center" aria-live="polite">
            {headline}
          </div>
          <RoundTimer deadline={game.phaseDeadline} durationMs={round?.durationMs ?? null} />
          <ConnectionBadge status={connection} compact />
        </header>

        <div className="shrink-0">
          <PlayerStrip room={room} selfId={playerId} />
        </div>

        {!online && (
          <p role="status" className="shrink-0 rounded-xl border border-candy/30 bg-[#2a1233] px-3 py-1.5 text-xs font-bold text-pink-100">
            Connection lost — reconnecting. Your seat is held for a short while.
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-2 wide:grid wide:grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] wide:gap-4">
          {matchOver ? (
            <div className="min-h-0 flex-1 wide:h-full">
              <FinalLeaderboard room={room} selfId={playerId} />
            </div>
          ) : (
            <section
              aria-label="Canvas"
              className="relative aspect-square max-h-full min-h-[7rem] w-full shrink wide:aspect-auto wide:h-full wide:min-h-0"
            >
              <DrawingCanvas
                roundId={round?.id ?? null}
                interactive={drawerActive && online}
                tool={tool}
                color={color}
                size={size}
                nextStrokeId={isDrawer ? (privateRound?.nextStrokeId ?? null) : null}
              />
              <RoundOverlay
                room={room}
                selfId={playerId}
                privateRound={privateRound}
                advanceDeadline={game.advanceDeadline}
              />
            </section>
          )}

          <div
            className={`flex min-h-0 flex-col gap-2 wide:h-full ${
              matchOver ? 'h-[clamp(6.5rem,24%,12rem)] shrink-0 wide:h-full' : drawerActive ? 'shrink-0 grow' : 'grow shrink-0'
            }`}
          >
            {drawerActive && (
              <DrawingToolbar
                tool={tool}
                color={color}
                size={size}
                onToolChange={setTool}
                onColorChange={setColor}
                onSizeChange={setSize}
                onClear={handleClear}
                disabled={!online}
              />
            )}
            <div className={`min-h-0 flex-1 ${drawerActive ? 'basis-[4.5rem]' : 'basis-[9rem]'}`}>
              <ChatPanel
                messages={game.chat}
                players={room.players}
                selfId={playerId}
                input={chatInput}
                inputDisabledReason={online ? null : 'Reconnecting…'}
                onSend={handleSend}
                compact={drawerActive}
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
