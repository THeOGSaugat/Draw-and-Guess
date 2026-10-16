import { useEffect, useRef, useState } from 'react';
import { BRUSH_COLORS, BRUSH_SIZES, type DrawTool } from '@draw-guess/shared';
import { EraserIcon, TrashIcon } from './icons';

interface DrawingToolbarProps {
  tool: DrawTool;
  color: string;
  size: number;
  onToolChange: (tool: DrawTool) => void;
  onColorChange: (color: string) => void;
  onSizeChange: (size: number) => void;
  onClear: () => void;
  disabled: boolean;
}

const MAX_SIZE = BRUSH_SIZES.at(-1)!.value;

export function DrawingToolbar(props: DrawingToolbarProps) {
  const { tool, color, size, onToolChange, onColorChange, onSizeChange, onClear, disabled } = props;
  const [confirmingClear, setConfirmingClear] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);

  function handleClear() {
    if (!confirmingClear) {
      // Two-step: wiping the whole drawing by accident on a phone is too easy.
      setConfirmingClear(true);
      confirmTimer.current = setTimeout(() => setConfirmingClear(false), 3000);
      return;
    }
    clearTimeout(confirmTimer.current);
    setConfirmingClear(false);
    onClear();
  }

  return (
    <div className="flex flex-col gap-2" role="toolbar" aria-label="Drawing tools">
      <div className="grid grid-cols-5 gap-1.5 min-[480px]:grid-cols-10" role="group" aria-label="Colors">
        {BRUSH_COLORS.map((c) => {
          const selected = tool === 'pen' && color === c.value;
          return (
            <button
              key={c.value}
              type="button"
              disabled={disabled}
              aria-label={c.name}
              aria-pressed={selected}
              onClick={() => {
                onColorChange(c.value);
                onToolChange('pen');
              }}
              className={`h-9 rounded-xl border-2 transition-transform active:scale-90 disabled:opacity-40 ${
                selected ? 'scale-105 border-white shadow-[0_0_0_2px_var(--color-sky)]' : 'border-white/15'
              }`}
              style={{ backgroundColor: c.value }}
            />
          );
        })}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="flex flex-1 gap-1.5" role="group" aria-label="Brush size">
          {BRUSH_SIZES.map((s) => {
            const selected = size === s.value;
            return (
              <button
                key={s.value}
                type="button"
                disabled={disabled}
                aria-label={`${s.name} brush`}
                aria-pressed={selected}
                onClick={() => onSizeChange(s.value)}
                className={`grid h-10 min-w-0 flex-1 place-items-center rounded-xl border-2 transition-colors disabled:opacity-40 ${
                  selected ? 'border-sky bg-sky/15' : 'border-white/10 bg-navy-900/80'
                }`}
              >
                <span
                  className="rounded-full bg-slate-100"
                  style={{ width: 4 + (s.value / MAX_SIZE) * 18, height: 4 + (s.value / MAX_SIZE) * 18 }}
                />
              </button>
            );
          })}
        </div>
        <button
          type="button"
          disabled={disabled}
          aria-label="Eraser"
          aria-pressed={tool === 'eraser'}
          onClick={() => onToolChange(tool === 'eraser' ? 'pen' : 'eraser')}
          className={`grid h-10 w-11 shrink-0 place-items-center rounded-xl border-2 text-xl transition-colors disabled:opacity-40 ${
            tool === 'eraser' ? 'border-sky bg-sky/15 text-sky' : 'border-white/10 bg-navy-900/80 text-slate-200'
          }`}
        >
          <EraserIcon />
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={handleClear}
          aria-label={confirmingClear ? 'Tap again to clear the whole drawing' : 'Clear drawing'}
          className={`flex h-10 shrink-0 items-center gap-1 rounded-xl border-2 px-2.5 text-sm font-bold transition-colors disabled:opacity-40 ${
            confirmingClear ? 'border-candy bg-candy text-white' : 'border-white/10 bg-navy-900/80 text-slate-200'
          }`}
        >
          <TrashIcon className="text-lg" />
          <span className={confirmingClear ? '' : 'sr-only min-[400px]:not-sr-only'}>{confirmingClear ? 'Sure?' : 'Clear'}</span>
        </button>
      </div>
    </div>
  );
}
