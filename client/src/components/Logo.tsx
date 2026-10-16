import { PencilIcon } from './icons';

const letters: { text: string; color: string; tilt: number }[] = [
  { text: 'Draw', color: 'text-candy', tilt: -4 },
  { text: '&', color: 'text-sun', tilt: 8 },
  { text: 'Guess', color: 'text-sky', tilt: 3 },
];

export function Logo({ size = 'lg' }: { size?: 'sm' | 'lg' }) {
  const big = size === 'lg';
  return (
    <div className={`flex items-center ${big ? 'flex-col gap-3' : 'gap-2'}`}>
      <div
        className={`grid place-items-center rounded-2xl bg-gradient-to-br from-candy via-grape to-sky text-white shadow-lg shadow-candy/30 ${
          big ? 'size-16 animate-wiggle text-4xl' : 'size-9 text-xl'
        }`}
      >
        <PencilIcon />
      </div>
      <h1
        className={`flex items-baseline gap-2 font-display font-bold leading-none ${big ? 'text-5xl sm:text-6xl' : 'text-xl'}`}
      >
        {letters.map((l) => (
          <span
            key={l.text}
            className={`inline-block ${l.color} drop-shadow-[0_3px_0_rgb(0_0_0/0.35)]`}
            style={{ transform: big ? `rotate(${l.tilt}deg)` : undefined }}
          >
            {l.text}
          </span>
        ))}
      </h1>
    </div>
  );
}
