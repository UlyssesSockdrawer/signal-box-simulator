import type { ThemeId } from '../core/types';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  /** Three colours for the little preview in Settings. */
  swatch: [string, string, string];
  /** Browser toolbar colour on phones. */
  barColour: string;
}

/** Colour themes. The colours themselves live in styles.css under :root[data-livery=…]. */
export const THEMES: ThemeInfo[] = [
  { id: 'device', name: 'Device (light or dark, as your device is set)', description: 'Follows your device’s light or dark setting.', swatch: ['#e9ece6', '#1f5546', '#121816'], barColour: '#1f5546' },
  { id: 'gwr', name: 'Great Western: Brunswick green, chocolate and cream', description: 'GWR locomotive green with chocolate-and-cream carriage colours. Light.', swatch: ['#efe6d2', '#5a3a22', '#1f4a2c'], barColour: '#1f4a2c' },
  { id: 'lms', name: 'LMS: crimson lake and gold', description: 'Midland crimson lake lined in gold, as on LMS expresses. Dark.', swatch: ['#2c1418', '#7a1f2b', '#d9ad45'], barColour: '#5c1520' },
  { id: 'lner', name: 'LNER: apple green and Garter blue', description: 'Apple green locomotives with Garter blue from the streamlined A4s. Light.', swatch: ['#eef1e6', '#3b7a1f', '#1a2f5c'], barColour: '#1a2f5c' },
  { id: 'sr', name: 'Southern: malachite green and sunshine yellow', description: 'Bulleid’s malachite green with sunshine yellow lettering. Dark.', swatch: ['#0d2419', '#1e6b45', '#f2c230'], barColour: '#0d2419' },
];

export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  if (theme === 'device') delete root.dataset.livery;
  else root.dataset.livery = theme;
  const info = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', info.barColour);
}
