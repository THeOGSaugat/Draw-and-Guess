import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { SpinnerIcon } from './icons';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary:
    'bg-gradient-to-b from-[#ff7aa3] to-candy text-white shadow-[0_5px_0_0_#c23a67,0_12px_24px_-8px_rgb(255_93_143/0.6)] active:shadow-[0_1px_0_0_#c23a67] active:translate-y-1',
  secondary:
    'bg-gradient-to-b from-[#7dd8f5] to-sky text-navy-950 shadow-[0_5px_0_0_#2a92b5,0_12px_24px_-8px_rgb(76_201_240/0.5)] active:shadow-[0_1px_0_0_#2a92b5] active:translate-y-1',
  ghost: 'bg-white/5 text-slate-200 border border-white/10 hover:bg-white/10 active:bg-white/15',
};

const sizes: Record<Size, string> = {
  md: 'min-h-12 px-4 text-base rounded-2xl',
  lg: 'min-h-14 px-6 text-lg rounded-2xl',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap font-display font-semibold tracking-wide transition-all duration-150 select-none disabled:pointer-events-none disabled:opacity-45 disabled:saturate-50 ${variants[variant]} ${sizes[size]} ${className}`}
      {...rest}
    >
      {loading ? <SpinnerIcon className="text-[1.15em]" /> : icon && <span className="text-[1.15em]">{icon}</span>}
      {children}
    </button>
  );
}
