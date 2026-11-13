// Browser end-to-end for ADR-0015 (Task 8): the GM marks leave; a Normal task stops climbing while a Critical one
// climbs; the assignee, GM and giver hear once; the worker sees it on My attendance; the task shows "on leave".
import { expect, test, type Browser, type Page } from "@playwright/test";
import { COS, E2E_PASSWORD, GM, LEAD, WORKER } from "./fixtures.js";
import { passwordSignIn, userMenu } from "./helpers.js";

const H = 3_600_000;

async function signedIn(
  browser: Browser,
  who: { name: string; email: string },
): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await passwordSignIn(page, who.email, E2E_PASSWORD);
  await expect(userMenu(page, who.name)).toBeVisible({ timeout: 30_000 });
  return page;
}
const api = async (
  page: Page,
  method: "GET" | "PUT" | "POST",
  path: string,
  data?: unknown,
) => {
  const res = await page.request.fetch(path, {
    method,
    data,
    headers: { "x-taskwatch": "1" },
  });
  expect(res.status(), `${method} ${path}: ${await res.text()}`).toBeLessThan(
    300,
  );
  return res.status() === 204 ? null : res.json();
};
const serverNow = async (page: Page) =>
  Date.parse((await api(page, "GET", "/api/me")).serverTime);

/** A fixed-offset zone where it is mid-morning now, so "leave today" covers the next ~12 hours whatever the real time. */
function morningZone(now: number): string {
  const utcHour = new Date(now).getUTCHours();
  for (let off = -12; off <= 14; off++)
    if ((((utcHour + off) % 24) + 24) % 24 === 10)
      return off === 0
        ? "UTC"
        : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
  return "UTC";
}
const local = (t: number, zone: string) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(t)
      .map((x) => [x.type, x.value]),
  );
  return {
    dueDate: `${p.year}-${p.month}-${p.day}`,
    dueTime: `${p.hour}:${p.minute}`,
  };
};

test("GM marks leave: Normal stops climbing, Critical climbs; one notice each; worker and task show it (ADR-0015)", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const [cos, gm, lead, worker] = [
    await signedIn(browser, COS),
    await signedIn(browser, GM),
    await signedIn(browser, LEAD),
    await signedIn(browser, WORKER),
  ];
  const now = await serverNow(gm);
  // Due dates are read in the vertical's zone (ADR-0015), which this test sets to `zone` below. Writing them in another
  // zone (it used IST) shifted "due in 6 h" by the zones' difference: at 00:00 UTC the due landed 1.5 h out and the
  // Normal task was past due, i.e. L1 by the due time, after the 2 h step.
  const zone = morningZone(now);

  // Setup through the API: BAIS works around the clock in a zone where it is morning; 1-hour update windows.
  // Put back at the end (finally), so the other specs see BAIS as before.
  try {
    await api(gm, "PUT", "/api/entities/BAIS/worktime", {
      timeZone: zone,
      quietHours: null,
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workStart: "00:00",
      workEnd: "24:00",
    });
    await api(gm, "PUT", "/api/rules/BAIS", {
      config: { windowsHours: { critical: 1, high: 24, normal: 1, low: 72 } },
    });
    const task = (priority: string, dueInH: number, title: string) =>
      api(lead, "POST", "/api/tasks", {
        title,
        category: "Operations",
        assigneeId: WORKER.id,
        priority,
        ...local(now + dueInH * H, zone),
        estimatedHours: 1,
        purpose: "support",
        instructions: "",
      }).then((r) => r.task.id as number);
    const normal = await task("normal", 6, "E2E leave: normal");
    const critical = await task("critical", 240, "E2E leave: critical");

    // The GM marks leave for today through the Attendance page, twice (the notice must still go once).
    await gm.goto("/attendance");
    // One-click marks: Leave, then clear, then Leave again (the notice must still go once).
    const row = gm.getByRole("group", { name: `Mark ${WORKER.name}` });
    const leaveBtn = row.getByRole("button", { name: "Leave" });
    await leaveBtn.click();
    await expect(gm.getByText(/1 day marked/).last()).toBeVisible();
    await row.getByRole("button", { name: `Clear the mark for ${WORKER.name}` }).click();
    await expect(row.getByRole("button", { name: `Clear the mark for ${WORKER.name}` })).toHaveCount(0);
    await leaveBtn.click();
    await expect(leaveBtn).toHaveAttribute("aria-pressed", "true");

    // Marking everyone else present must not overwrite the leave (review I-2).
    await gm.getByRole("button", { name: /unmarked present/i }).click();
    await expect(gm.getByText(/days? marked/).last()).toBeVisible();
    await expect(leaveBtn).toHaveAttribute("aria-pressed", "true");

  // Two hours later: the Critical task is past L1 (1 h × 1.5); the Normal one is paused by the leave.
    await api(cos, "POST", "/api/dev/clock", { advanceHours: 2 });
    const level = async (id: number) =>
      (await api(lead, "GET", `/api/tasks/${id}`)).task.level as number;
    expect(await level(critical)).toBeGreaterThanOrEqual(1);
    expect(await level(normal)).toBe(-1);

    // One notice each for the assignee, the GM and the giver.
    for (const page of [worker, gm, lead]) {
      const items = (await api(page, "GET", "/api/notifications?limit=100"))
        .items as { title: string; taskId: number }[];
      expect(
        items.filter(
          (n) => n.taskId === normal && /is on leave today/.test(n.title),
        ),
      ).toHaveLength(1);
    }

    // The worker sees it on My attendance; the task page says the assignee is on leave.
    await worker.goto("/my-attendance");
    await expect(
      worker.getByText("Leave", { exact: true }).first(),
    ).toBeVisible();
    await lead.goto(`/tasks/${normal}`);
    await expect(lead.getByText("Assignee on leave")).toBeVisible();
  } finally {
    await api(gm, "PUT", "/api/entities/BAIS/worktime", {
      timeZone: null,
      quietHours: null,
      workDays: null,
      workStart: null,
      workEnd: null,
    });
    await gm.request.fetch("/api/rules/BAIS", {
      method: "DELETE",
      headers: { "x-taskwatch": "1" },
    });
  }
});
