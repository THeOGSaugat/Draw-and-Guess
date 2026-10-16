import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { CHAT_MAX_LENGTH, type ChatMessage, type PublicPlayer } from '@draw-guess/shared';
import { CheckIcon, SendIcon } from './icons';

interface ChatPanelProps {
  messages: ChatMessage[];
  players: PublicPlayer[];
  selfId: string;
  /** null hides the input (e.g. the drawer during a round). */
  input: { placeholder: string; label: string } | null;
  inputDisabledReason: string | null;
  onSend: (text: string) => Promise<string | null>;
  compact?: boolean;
}

export function ChatPanel({ messages, players, selfId, input, inputDisabledReason, onSend, compact }: ChatPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const colorOf = (id: string | null) => players.find((p) => p.id === id)?.color ?? '#94a3b8';

  // Follow new messages unless the player has scrolled up to read history.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
  }, [messages]);

  // Keep the newest messages visible when the keyboard opens and the panel shrinks.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) list.scrollTop = list.scrollHeight;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    const problem = await onSend(value);
    setSending(false);
    setError(problem);
    if (!problem) setText('');
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        ref={listRef}
        role="log"
        aria-label="Chat and guesses"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl bg-navy-900/70 px-3 py-2 text-sm ${
          compact ? 'space-y-0.5' : 'space-y-1'
        }`}
      >
        {messages.length === 0 && <p className="py-2 text-center text-xs font-semibold text-slate-500">No messages yet</p>}
        {messages.map((m) => {
          if (m.kind === 'system') {
            return (
              <p key={m.id} className="py-0.5 text-center text-xs font-bold text-slate-400">
                {m.text}
              </p>
            );
          }
          if (m.kind === 'correct') {
            return (
              <p key={m.id} className="flex items-center gap-1.5 rounded-lg bg-mint/15 px-2 py-1 font-bold text-mint">
                <CheckIcon className="shrink-0" />
                <span className="min-w-0 flex-1 break-words">{m.playerId === selfId ? 'You guessed the word!' : m.text}</span>
                {m.points !== undefined && <span className="shrink-0 font-display tabular-nums">+{m.points}</span>}
              </p>
            );
          }
          return (
            <p
              key={m.id}
              className={`break-words ${m.scope === 'guessed' ? 'rounded-lg bg-mint/10 px-2 py-0.5' : ''}`}
            >
              <span className="font-extrabold" style={{ color: colorOf(m.playerId) }}>
                {m.playerId === selfId ? 'You' : m.nickname}
              </span>
              {m.scope === 'guessed' && (
                <span className="ml-1 text-[0.7rem] font-bold text-mint/80">
                  {m.withheld ? '(hidden from guessers)' : '(guessed only)'}
                </span>
              )}
              <span className="text-slate-400">: </span>
              <span className="text-slate-100">{m.text}</span>
            </p>
          );
        })}
      </div>

      {input && (
        <form onSubmit={submit} className="flex shrink-0 gap-2">
          <label htmlFor="chat-input" className="sr-only">
            {input.label}
          </label>
          <input
            id="chat-input"
            className="field min-w-0 flex-1 py-2.5"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            maxLength={CHAT_MAX_LENGTH}
            placeholder={inputDisabledReason ?? input.placeholder}
            disabled={inputDisabledReason !== null}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="send"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'chat-error' : undefined}
          />
          <button
            type="submit"
            disabled={inputDisabledReason !== null || sending || text.trim() === ''}
            aria-label="Send"
            className="grid size-12 shrink-0 place-items-center rounded-2xl bg-sky text-xl text-navy-950 transition-transform active:scale-95 disabled:opacity-40"
          >
            <SendIcon />
          </button>
        </form>
      )}
      {error && (
        <p id="chat-error" role="alert" className="-mt-1 shrink-0 text-xs font-bold text-candy">
          {error}
        </p>
      )}
    </div>
  );
}
