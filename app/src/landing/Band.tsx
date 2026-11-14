import AsciiCanvas from './AsciiCanvas';
import { paintBand } from './ascii';
import { useThemeStore } from '../theme';

/** Height of the band: six rows of small characters. */
export const BAND_H = 44;

/**
 * The border across the top and the bottom of the landing page: a strip of sea from edge to
 * edge, drawn in characters (`paintBand`). `line` is the colour of the rule that
 * separates it from the page.
 */
export default function Band({ edge = 'top', line }: { edge?: 'top' | 'bottom'; line: string }) {
  const dark = useThemeStore(s => s.mode) === 'dark';
  return (
    <div style={{ flexShrink: 0, [edge === 'top' ? 'borderBottom' : 'borderTop']: `1px solid ${line}`, transition: 'border-color 0.4s' }}>
      <AsciiCanvas scene={paintBand} ink={dark ? '255,255,255' : '0,0,0'} accent={dark ? '120,240,160' : '47,179,106'} dark={dark}
        fontPx={6} offset={edge === 'top' ? 0 : 7} style={{ width: '100%', height: BAND_H, alignItems: 'center' }} />
    </div>
  );
}
