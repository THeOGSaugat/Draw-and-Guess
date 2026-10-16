import type { ConnectionStatus } from '../lib/gameStore';

const styles: Record<ConnectionStatus, { label: string; dot: string; text: string }> = {
  connected: { label: 'Online', dot: 'bg-mint', text: 'text-mint' },
  connecting: { label: 'Connecting…', dot: 'bg-sun animate-pulse', text: 'text-sun' },
  reconnecting: { label: 'Reconnecting…', dot: 'bg-candy animate-pulse', text: 'text-candy' },
};

/** `compact` hides the label on narrow screens (the dot and screen-reader text remain). */
export function ConnectionBadge({ status, compact = false }: { status: ConnectionStatus; compact?: boolean }) {
  const s = styles[status];
  return (
    <div
      role="status"
      aria-live="polite"
      title={s.label}
      className={`inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-navy-900/80 py-1.5 text-xs font-bold ${
        compact ? 'px-2.5 min-[400px]:px-3' : 'px-3'
      }`}
    >
      <span className={`relative inline-flex size-2.5 rounded-full ${s.dot}`}>
        {status === 'connected' && <span className="absolute inset-0 animate-ping rounded-full bg-mint opacity-40" />}
      </span>
      <span className={`${s.text} ${compact ? 'sr-only min-[400px]:not-sr-only' : ''}`}>{s.label}</span>
    </div>
  );
}
