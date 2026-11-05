// Browser end-to-end: the Auth feature through the real UI against the real API (T-2.7; AUTH-01b, 02, 04; D-94).
import crypto from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import pg from 'pg';
import { e2eDatabaseUrl, E2E_PASSWORD, MANAGER, STAFF } from './fixtures.js';

try {
  process.loadEnvFile('.env'); // DATABASE_URL, to reach the e2e database
} catch {
  /* CI may pass it in the environment */
}

async function passwordSignIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

/** The signed-in user's menu button in the shell: the only button with a menu popup (never a dev-login tile). */
const userMenu = (page: Page, name: string) => page.locator('button[aria-haspopup="menu"]', { hasText: name });

async function signOut(page: Page, name: string) {
  await userMenu(page, name).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

test.describe.configure({ mode: 'serial' }); // one database, one sequence of sign-ins

test('staff: a wrong password is refused with the generic message; the right one opens the app; sign-out returns to sign-in', async ({ page }) => {
  await passwordSignIn(page, STAFF.email, 'not-the-password');
  await expect(page.getByText('That email and password combination is not recognized.')).toBeVisible();
  await passwordSignIn(page, STAFF.email, E2E_PASSWORD);
  await expect(userMenu(page, STAFF.name)).toBeVisible();
  await expect(page.getByText(/is not connected to the server yet/)).toBeVisible();
  await signOut(page, STAFF.name);
});

test('manager: signs in with the password alone (no second factor, D-94)', async ({ page }) => {
  await passwordSignIn(page, MANAGER.email, E2E_PASSWORD);
  await expect(userMenu(page, MANAGER.name)).toBeVisible();
  await signOut(page, MANAGER.name);
});

test('forgot and reset password: a link from email resets the password; the old one stops working', async ({ page }) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Work email').fill(STAFF.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(`If an account exists for ${STAFF.email}, a reset link has been issued.`)).toBeVisible();
  await expect(page.getByText(/simulated reset link/)).toHaveCount(0); // no token ever reaches the page
  // The email is not available to the test, so it stands in with a token of its own, stored the same way (hash only).
  const token = crypto.randomBytes(32).toString('base64url');
  const db = new pg.Client({ connectionString: e2eDatabaseUrl(process.env.DATABASE_URL) });
  await db.connect();
  await db.query(`insert into password_reset_tokens (token_hash, user_id, created_at, expires_at) values ($1, $2, now(), now() + interval '1 hour')`, [
    crypto.createHash('sha256').update(token).digest(),
    STAFF.id,
  ]);
  await db.end();
  await page.goto(`/reset-password?token=${token}`);
  await page.getByLabel('New password').fill('short1');
  await page.getByLabel('Confirm password').fill('short1');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
  await page.getByLabel('New password').fill('brand-new-pass-7');
  await page.getByLabel('Confirm password').fill('brand-new-pass-7');
  await page.getByRole('button', { name: 'Reset password' }).click();
  await expect(page.getByText('Your password has been reset.')).toBeVisible();
  await passwordSignIn(page, STAFF.email, E2E_PASSWORD);
  await expect(page.getByText('That email and password combination is not recognized.')).toBeVisible();
  await passwordSignIn(page, STAFF.email, 'brand-new-pass-7');
  await expect(userMenu(page, STAFF.name)).toBeVisible();
});
