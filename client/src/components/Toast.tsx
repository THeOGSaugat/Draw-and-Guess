import { useEffect } from 'react';
import { dismissNotice, type Notice } from '../lib/gameStore';

export function Toast({ notice }: { notice: Notice | null }) {
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => dismissNotice(notice.id), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-[max(0.75rem,env(safe-area-inset-top))]"
    >
      {notice && (
        <button
          key={notice.id}
          type="button"
          onClick={() => dismissNotice(notice.id)}
          className={`pointer-events-auto w-full max-w-sm animate-pop-in rounded-2xl border px-4 py-3 text-left text-sm font-bold shadow-xl ${
            notice.kind === 'error'
              ? 'border-candy/40 bg-[#3a1430]/95 text-pink-100'
              : 'border-sky/40 bg-[#0f2a44]/95 text-sky-100'
          }`}
        >
          {notice.text}
          <span className="mt-0.5 block text-xs font-semibold opacity-60">Tap to dismiss</span>
        </button>
      )}
    </div>
  );
}
