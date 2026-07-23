/**
 * Dusk Terminal theme toggle.
 *
 * Tokens themselves live as CSS custom properties in src/routes/layout.css:
 * `:root` (and `[data-theme="dark"]`) define the dark palette, a
 * `prefers-color-scheme: light` media query supplies the light palette as
 * the OS-default fallback, and `[data-theme="light"]` lets an explicit user
 * choice always win over the OS preference. This module just manages that
 * `data-theme` attribute plus persistence, so any component can call
 * `setTheme`/`toggleTheme` without duplicating the storage/DOM logic.
 */

export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'dusk-terminal-theme';

function isTheme(value: string | null): value is Theme {
	return value === 'dark' || value === 'light';
}

function readStoredTheme(): Theme | null {
	if (typeof localStorage === 'undefined') return null;
	const stored = localStorage.getItem(STORAGE_KEY);
	return isTheme(stored) ? stored : null;
}

/** Reactive current theme, or `null` if the user hasn't made an explicit choice
 *  (in which case `prefers-color-scheme` in CSS drives the palette). */
export const themeState = $state<{ current: Theme | null }>({
	current: null
});

export function initTheme(): void {
	themeState.current = readStoredTheme();
}

export function applyTheme(theme: Theme | null): void {
	themeState.current = theme;
	if (typeof document === 'undefined') return;
	if (theme === null) {
		document.documentElement.removeAttribute('data-theme');
		localStorage.removeItem(STORAGE_KEY);
		return;
	}
	document.documentElement.setAttribute('data-theme', theme);
	localStorage.setItem(STORAGE_KEY, theme);
}

export function toggleTheme(): void {
	const prefersDark =
		typeof window !== 'undefined' &&
		typeof window.matchMedia === 'function' &&
		window.matchMedia('(prefers-color-scheme: dark)').matches;
	const effectiveCurrent = themeState.current ?? (prefersDark ? 'dark' : 'light');
	applyTheme(effectiveCurrent === 'dark' ? 'light' : 'dark');
}
