import { useEffect, useState } from 'react';
import { ClockIcon } from './icons';

/** Counts down to a local deadline. Progress bar + seconds; urgent styling for the last 10s. */
export function RoundTimer({ deadline, durationMs }: { deadline: number | null; durationMs: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline === null || durationMs === null) return null;
  const remaining = Math.max(0, deadline - now);
  const seconds = Math.ceil(remaining / 1000);
  const urgent = seconds <= 10;
  const progress = Math.min(1, remaining / durationMs);

  return (
    <div
      role="timer"
      aria-label={`${seconds} seconds left`}
      className={`relative flex h-9 w-[4.25rem] shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border font-display text-base font-bold tabular-nums ${
        urgent ? 'border-candy/60 bg-candy/15 text-candy' : 'border-white/10 bg-navy-900/80 text-white'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 transition-[width] duration-300 ease-linear ${urgent ? 'bg-candy/20' : 'bg-sky/15'}`}
        style={{ width: `${progress * 100}%` }}
      />
      <ClockIcon className={`relative text-sm ${urgent ? 'animate-pulse' : ''}`} />
      <span className="relative">{seconds}</span>
    </div>
  );
}
