// Minimal stand-in for WAVdesk's ThemeContext so the ported components
// keep their useTheme()/THEME_BG surface. One dark theme for now; the
// full theme system arrives if/when the shared UI kit becomes a package.

export type ThemeName = 'dark';

export const THEME_BG: Record<ThemeName, string> = {
  dark: '#09090b',
};

export function useTheme(): { theme: ThemeName } {
  return { theme: 'dark' };
}
