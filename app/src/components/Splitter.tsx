import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTheme } from '../theme';

/**
 * A draggable divider between two panels. Drag it, or focus it and use the arrow keys;
 * double-click (or Home) resets. Adapted from the earlier Pacifica frontend's Splitter.
 *
 * `onDelta` receives the pointer movement in pixels along the axis: positive is right or down.
 */
export default function Splitter({ dir, onDelta, onReset, label }: {
  dir: 'h' | 'v'; onDelta: (px: number) => void; onReset?: () => void; label: string;
}) {
  const { t } = useTheme();
  const [hot, setHot] = useState(false);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const axis = dir === 'h' ? 'clientX' : 'clientY';
    let last = e[axis];
    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = dir === 'h' ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
    setDragging(true);

    const onMove = (ev: globalThis.PointerEvent) => {
      onDelta(ev[axis] - last);
      last = ev[axis];
    };
    const onUp = () => {
      setDragging(false);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const back = dir === 'h' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = dir === 'h' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === back) onDelta(-step);
    else if (e.key === fwd) onDelta(step);
    else if (e.key === 'Home') onReset?.();
    else return;
    e.preventDefault();
  };

  const on = hot || dragging;
  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation={dir === 'h' ? 'vertical' : 'horizontal'}
      aria-label={label}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onReset?.()}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onFocus={() => setHot(true)}
      onBlur={() => setHot(false)}
      style={{
        [dir === 'h' ? 'width' : 'height']: 6, flexShrink: 0, zIndex: 12, touchAction: 'none', outline: 'none',
        cursor: dir === 'h' ? 'ew-resize' : 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: on ? t.ACCENT_BG : 'transparent', transition: 'background 0.12s',
      }}
    >
      <div style={{
        width: dir === 'h' ? 1 : '100%', height: dir === 'h' ? '100%' : 1,
        background: on ? t.ACCENT : t.LINE, transition: 'background 0.12s',
      }} />
    </div>
  );
}
