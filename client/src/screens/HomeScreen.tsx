import { useMemo, useState, type FormEvent } from 'react';
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  NICKNAME_MAX_LENGTH,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  nicknameProblem,
  normalizeNickname,
  normalizeRoomCode,
} from '@draw-guess/shared';
import { Button } from '../components/Button';
import { useSlowConnect } from '../lib/useSlowConnect';
import { ConnectionBadge } from '../components/ConnectionBadge';
import { ArrowRightIcon, PlusIcon } from '../components/icons';
import { Logo } from '../components/Logo';
import {
  createRoom,
  joinRoom,
  notify,
  type ActionResult,
  type ClientError,
  type ConnectionStatus,
} from '../lib/gameStore';
import { extractRoomCode, loadNickname, readInviteCode, saveNickname } from '../lib/storage';

const NICKNAME_ERRORS = new Set(['INVALID_NICKNAME', 'NICKNAME_TAKEN']);
const CODE_ERRORS = new Set(['INVALID_ROOM_CODE', 'ROOM_NOT_FOUND', 'ROOM_FULL', 'GAME_IN_PROGRESS']);

export function HomeScreen({ connection }: { connection: ConnectionStatus }) {
  const invitedCode = useMemo(readInviteCode, []);
  const [nickname, setNickname] = useState(loadNickname);
  const [code, setCode] = useState(invitedCode ?? '');
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [pending, setPending] = useState<'create' | 'join' | null>(null);
  const online = connection === 'connected';
  const slowConnect = useSlowConnect(online);

  function validNickname(): string | null {
    const clean = normalizeNickname(nickname);
    const problem = nicknameProblem(clean);
    setNicknameError(problem);
    return problem ? null : clean;
  }

  function showServerError(error: ClientError) {
    if (NICKNAME_ERRORS.has(error.code)) setNicknameError(error.message);
    else if (CODE_ERRORS.has(error.code)) setCodeError(error.message);
    else notify('error', error.message);
  }

  async function run(kind: 'create' | 'join', action: (name: string) => Promise<ActionResult<unknown>>) {
    const name = validNickname();
    if (!name || pending) return;
    saveNickname(name);
    setPending(kind);
    const result = await action(name);
    // On success the app switches screens and this component unmounts.
    if (!result.ok) {
      setPending(null);
      showServerError(result.error);
    }
  }

  function handleCreate() {
    setCodeError(null);
    void run('create', createRoom);
  }

  function handleJoin(event?: FormEvent) {
    event?.preventDefault();
    const normalized = normalizeRoomCode(code);
    const codeOk = isValidRoomCode(normalized);
    setCodeError(codeOk ? null : `Enter the ${ROOM_CODE_LENGTH}-character code from your host.`);
    if (!codeOk) {
      validNickname();
      return;
    }
    void run('join', (name) => joinRoom(normalized, name));
  }

  const joinPrimary = invitedCode !== null;

  const createButton = (
    <Button
      className="w-full"
      size="lg"
      variant={joinPrimary ? 'ghost' : 'primary'}
      icon={<PlusIcon />}
      loading={pending === 'create'}
      disabled={!online || pending !== null}
      onClick={handleCreate}
    >
      Create Room
    </Button>
  );

  const joinForm = (
    <form onSubmit={handleJoin} noValidate>
      <label htmlFor="room-code" className="sr-only">
        Room code
      </label>
      <div className="flex gap-2.5">
        <input
          id="room-code"
          className="field min-w-0 flex-1 text-center font-display text-xl font-semibold tracking-[0.35em] uppercase placeholder:tracking-[0.2em]"
          value={code}
          onChange={(e) => {
            setCode(extractRoomCode(e.target.value));
            setCodeError(null);
          }}
          placeholder="CODE"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? 'code-error' : undefined}
        />
        <Button
          type="submit"
          size="lg"
          variant={joinPrimary ? 'primary' : 'secondary'}
          loading={pending === 'join'}
          disabled={!online || pending !== null}
          icon={<ArrowRightIcon />}
          className="shrink-0"
        >
          Join
        </Button>
      </div>
      {codeError && (
        <p id="code-error" className="mt-2 text-sm font-bold text-candy">
          {codeError}
        </p>
      )}
    </form>
  );

  return (
    <main className="safe-px mx-auto flex min-h-dvh w-full max-w-md flex-col pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      <header className="flex justify-end">
        <ConnectionBadge status={connection} />
      </header>

      <section className="flex animate-fade-up flex-col items-center pt-6 pb-8 text-center sm:pt-10">
        <Logo />
        <p className="mt-4 max-w-xs text-base font-semibold text-slate-300">
          Sketch it. Guess it. Laugh about it — with {MIN_PLAYERS}–{MAX_PLAYERS} friends.
        </p>
      </section>

      <div className="panel animate-fade-up p-5 [animation-delay:80ms] sm:p-6">
        {invitedCode && (
          <div className="mb-5 rounded-2xl border border-sun/30 bg-sun/10 px-4 py-3 text-sm font-bold text-sun">
            Joining room <span className="font-display tracking-widest">{invitedCode}</span>. Pick a nickname and hop in!
          </div>
        )}

        <label htmlFor="nickname" className="mb-2 block font-display text-sm font-semibold tracking-wide text-slate-300">
          Your nickname
        </label>
        <div className="relative">
          <input
            id="nickname"
            className="field pr-14 font-semibold"
            value={nickname}
            onChange={(e) => {
              setNickname(e.target.value);
              setNicknameError(null);
            }}
            onKeyDown={(e) => {
              // Ignore Enter while an IME (e.g. Devanagari, Japanese) is composing text.
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) (joinPrimary ? handleJoin : handleCreate)();
            }}
            maxLength={NICKNAME_MAX_LENGTH + 4}
            placeholder="e.g. Picasso"
            autoComplete="nickname"
            enterKeyHint="go"
            aria-invalid={nicknameError ? true : undefined}
            aria-describedby={nicknameError ? 'nickname-error' : undefined}
          />
          <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-xs font-bold text-slate-500">
            {[...normalizeNickname(nickname)].length}/{NICKNAME_MAX_LENGTH}
          </span>
        </div>
        {nicknameError && (
          <p id="nickname-error" className="mt-2 text-sm font-bold text-candy">
            {nicknameError}
          </p>
        )}

        <div className="mt-5">{joinPrimary ? joinForm : createButton}</div>

        <div className="my-5 flex items-center gap-3 text-xs font-extrabold tracking-[0.2em] text-slate-500 uppercase">
          <span className="h-px flex-1 bg-white/10" />
          {joinPrimary ? 'or start your own' : 'or join a friend'}
          <span className="h-px flex-1 bg-white/10" />
        </div>

        {joinPrimary ? createButton : joinForm}

        {!online && (
          <p className="mt-4 text-center text-sm font-semibold text-slate-400">
            {connection === 'connecting' ? 'Connecting to the game server…' : "Can't reach the game server. Retrying…"}
            {slowConnect && (
              <span className="mt-1 block text-xs text-slate-500">
                The server may be waking up after a quiet spell. The first visit can take up to a minute.
              </span>
            )}
          </p>
        )}
      </div>

      <p className="mt-auto pt-8 text-center text-xs font-semibold text-slate-500">
        No sign-up needed · Rooms disappear when everyone leaves
      </p>
    </main>
  );
}
