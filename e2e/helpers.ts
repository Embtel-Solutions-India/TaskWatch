// Browser helpers shared by the e2e specs (Playwright only; the server launcher must not import this file).
import type { Page } from '@playwright/test';

export async function passwordSignIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password); // not the "Show password" button (login redesign)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The signed-in user's menu button in the shell: the only button with a menu popup (never a dev-login tile). */
export const userMenu = (page: Page, name: string) => page.locator('button[aria-haspopup="menu"]', { hasText: name });
