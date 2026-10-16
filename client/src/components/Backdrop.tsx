/** Decorative, non-interactive background: soft color glows and floating doodles. */
export function Backdrop() {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(60%_40%_at_10%_0%,rgb(255_93_143/0.18),transparent_70%),radial-gradient(50%_40%_at_100%_20%,rgb(76_201_240/0.16),transparent_70%),radial-gradient(60%_50%_at_50%_110%,rgb(179_136_255/0.18),transparent_70%)]" />
      <div className="absolute inset-0 opacity-[0.07] [background-image:radial-gradient(rgb(255_255_255)_1px,transparent_1px)] [background-size:22px_22px]" />

      <svg className="absolute top-[12%] left-[6%] w-10 animate-float text-sun/35 [--tilt:-12deg]" viewBox="0 0 24 24">
        <path fill="currentColor" d="m12 2 2.6 6.6L21 9.3l-5 4.6 1.5 6.9L12 17.3l-5.5 3.5L8 13.9 3 9.3l6.4-.7z" />
      </svg>
      <svg
        className="absolute top-[30%] right-[5%] w-16 animate-float text-sky/30 [--tilt:10deg] [animation-delay:-2s]"
        viewBox="0 0 60 20"
      >
        <path d="M2 10c6-10 10 10 16 0s10 10 16 0 10 10 16 0 6-6 8-4" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      </svg>
      <svg
        className="absolute bottom-[14%] left-[8%] w-12 animate-float text-mint/25 [--tilt:20deg] [animation-delay:-4s]"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="3.5" />
      </svg>
      <svg
        className="absolute right-[10%] bottom-[8%] w-9 animate-float text-candy/30 [--tilt:-20deg] [animation-delay:-1s]"
        viewBox="0 0 24 24"
      >
        <path d="M4 20 20 4M4 4l16 16" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      </svg>
    </div>
  );
}
