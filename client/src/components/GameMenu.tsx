import { useEffect, useRef, useState } from 'react';
import { leaveRoom, notify, returnToLobby } from '../lib/gameStore';
import { ExitIcon, MenuIcon } from './icons';

export function GameMenu({ isHost }: { isHost: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="Game menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="grid size-10 place-items-center rounded-full border border-white/10 bg-navy-900/80 text-xl text-slate-200"
      >
        <MenuIcon />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-12 left-0 z-30 flex w-52 animate-pop-in flex-col gap-1 rounded-2xl border border-white/10 bg-navy-800 p-1.5 shadow-xl"
        >
          {isHost && (
            <button
              type="button"
              role="menuitem"
              className="rounded-xl px-3 py-3 text-left text-sm font-bold text-slate-100 hover:bg-white/10"
              onClick={async () => {
                setOpen(false);
                const result = await returnToLobby();
                if (!result.ok) notify('error', result.error.message);
              }}
            >
              Back to lobby
              <span className="block text-xs font-semibold text-slate-400">Ends this round for everyone</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="flex items-center gap-2 rounded-xl px-3 py-3 text-left text-sm font-bold text-candy hover:bg-white/10"
            onClick={() => {
              setOpen(false);
              void leaveRoom();
            }}
          >
            <ExitIcon /> Leave room
          </button>
        </div>
      )}
    </div>
  );
}
