// Browser end-to-end for ADR-0014 (Task 13): the 10-minute countdown, L1 at the due time, and a GM-tuned L2.
// Real UI against the real API; time is moved with the dev clock (/api/dev/clock, CoS, DEMO_TOOLS on the e2e server).
import { expect, test, type Browser, type Page } from '@playwright/test';
import { COS, E2E_PASSWORD, GM, LEAD, WORKER } from './fixtures.js';
import { passwordSignIn, userMenu } from './helpers.js';

const MIN = 60_000;
const TZ = 'Asia/Kolkata'; // every e2e person's zone: the form reads dates and times in it
const TITLE = 'E2E countdown: visa packet';

async function signedIn(browser: Browser, who: { name: string; email: string }): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await passwordSignIn(page, who.email, E2E_PASSWORD);
  await expect(userMenu(page, who.name)).toBeVisible();
  return page;
}

const serverNow = async (page: Page) => Date.parse((await (await page.request.get('/api/me')).json()).serverTime);

/** Move the server clock (CoS only) so that it reads `target`; the engine runs on the same request. */
async function clockTo(cos: Page, target: number) {
  const hours = (target - (await serverNow(cos))) / (60 * MIN);
  expect(hours).toBeGreaterThan(0);
  const res = await cos.request.post('/api/dev/clock', { data: { advanceHours: hours }, headers: { 'x-taskwatch': '1' } });
  expect(res.status()).toBe(200);
}

const localDate = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const localTime = (t: number) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);

async function notificationsOf(page: Page) {
  await page.goto('/notifications');
  return page.locator('body');
}

test('countdown, L1 at due, GM-tuned L2 (ADR-0014: US-05, D-140, D-141, D-146)', async ({ browser }) => {
  test.setTimeout(120_000);
  const [cos, lead, worker, gm] = [await signedIn(browser, COS), await signedIn(browser, LEAD), await signedIn(browser, WORKER), await signedIn(browser, GM)];

  // 1. The lead creates a Critical task for the worker: start now, due 40 minutes later (whole minutes, lead's zone).
  const start = Math.ceil((await serverNow(lead)) / MIN) * MIN;
  const due = start + 40 * MIN;
  await lead.goto('/tasks/new');
  await lead.locator('#t-title').fill(TITLE);
  await lead.locator('#t-assignee').selectOption(String(WORKER.id));
  // D-155 form: Priority and Purpose are button groups (role radio), not selects.
  await lead.getByRole('radiogroup', { name: 'Priority' }).getByRole('radio', { name: 'Critical' }).click();
  await lead.getByRole('radiogroup', { name: 'Purpose' }).getByRole('radio', { name: 'Support' }).click();
  await lead.locator('#t-due').fill(localDate(due));
  await lead.locator('#t-time').fill(localTime(due));
  await lead.locator('#t-start').fill(localDate(start));
  await lead.locator('#t-start-time').fill(localTime(start));
  await lead.locator('#t-est').fill('0.5');
  await lead.getByRole('button', { name: 'Assign task' }).click();
  await expect(lead.getByRole('heading', { name: TITLE })).toBeVisible();

  // 2. Ten minutes before the due time the worker's floating countdown shows about 10:00.
  await clockTo(cos, due - 10 * MIN + 2_000);
  await worker.goto('/');
  const pill = worker.locator('.deadline-timer');
  await expect(pill).toContainText(TITLE);
  await expect(pill.locator('.deadline-clock')).toHaveText(/^(10:00|09:[0-5]\d)$/);

  // 3. At the due time the pill turns overdue and the lead has L1 (L1 is the due time itself).
  await clockTo(cos, due + 2_000);
  await worker.goto('/');
  await expect(worker.locator('.deadline-timer.is-overdue')).toContainText(TITLE);
  await expect(await notificationsOf(lead)).toContainText(/L1 Team lead.*E2E countdown|E2E countdown.*L1 Team lead/s);

  // 4. The GM sets Critical L2 to 30 minutes for their vertical and applies it to open tasks (D-141, D-146).
  await gm.goto('/admin/policies');
  // The field has a unit picker (1440 min shows as 24 h): switch to minutes, then enter 30.
  await gm.getByLabel('Critical L2 after due unit').selectOption('min');
  await gm.getByLabel('Critical L2 after due (minutes)').fill('30');
  await gm.getByRole('button', { name: 'Save vertical policy' }).click();
  await gm.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await gm.getByRole('button', { name: 'Apply to open tasks' }).click();
  await gm.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(gm.getByText(/\d+ open tasks? rescheduled/)).toBeVisible(); // other specs may leave open BAIS tasks

  // 5. Thirty minutes after the due time the GM (the lead's manager) has L2.
  await clockTo(cos, due + 30 * MIN + 2_000);
  await expect(await notificationsOf(gm)).toContainText(/L2 Manager/);
});
