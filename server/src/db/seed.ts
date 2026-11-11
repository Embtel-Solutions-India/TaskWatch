import { pathToFileURL } from 'node:url';
import * as clock from '../clock.js';
import { HOUR, MINUTE } from '../clock.js';
import { config } from '../config.js';
import { DEFAULT_RULES, type Priority } from '../domain.js';
import { runEngine } from '../engine/engine.js';
import { runChainCheck } from '../jobs/scheduler.js';
import { setDispatcherEnabled } from '../notify/dispatcher.js';
import { getDirectory, invalidateDirectory, type DirUser } from '../services/directory.js';
import { saveRecurring } from '../services/recurring.js';
import { invalidateRules } from '../services/rules.js';
import { acknowledge, changeDue, createTask, postUpdate, reassignTask } from '../services/tasks.js';
import { addComment } from '../services/collab.js';
import { migrate } from './migrate.js';
import { pool } from './pool.js';

// Sample directory for demos and the pilot dry-run. Everyone except the Chief of Staff uses
// example.com addresses and fictional +1-415-555-01xx numbers, so nothing reaches a real person.

const PT = 'America/Los_Angeles';
const IST = 'Asia/Kolkata';

const ENTITIES = [
  ['FO', "Founder's Office"],
  ['BAIS', 'Bay Area Immigration Services'],
  ['USAIS', 'USAIS'],
  ['IE', 'International Evaluations'],
  ['EMBTEL', 'Embtel'],
  ['BAAS', 'Bay Area Accounting Solutions'],
] as const;

interface Person {
  key: string;
  name: string;
  title: string;
  entity: string;
  roles: string[];
  manager?: string;
  tz: string;
  email?: string;
  noPhone?: boolean;
}

// The Chief of Staff's real mailbox (for password-reset mail) comes from SEED_COS_EMAIL in .env, never from the repo.
const PEOPLE: Person[] = [
  { key: 'alka', name: 'Dr. Alka Madan', title: 'Founder & CEO', entity: 'FO', roles: ['ceo'], tz: PT, noPhone: true },
  { key: 'rahul', name: 'Rahul Kashyap', title: 'Chief of Staff', entity: 'FO', roles: ['cos'], manager: 'alka', tz: PT, email: process.env.SEED_COS_EMAIL || 'rahul@example.com', noPhone: true },

  { key: 'maria', name: 'Maria Gonzales', title: 'Operations Manager', entity: 'BAIS', roles: ['manager'], manager: 'rahul', tz: PT },
  { key: 'priya', name: 'Priya Nair', title: 'Case Team Lead — Family', entity: 'BAIS', roles: ['lead', 'staff'], manager: 'maria', tz: IST },
  { key: 'jordan', name: 'Jordan Lee', title: 'Case Team Lead — Employment', entity: 'BAIS', roles: ['lead'], manager: 'maria', tz: PT },
  { key: 'ananya', name: 'Ananya Iyer', title: 'Case Associate', entity: 'BAIS', roles: ['staff'], manager: 'priya', tz: IST },
  { key: 'rohit', name: 'Rohit Verma', title: 'Case Associate', entity: 'BAIS', roles: ['staff'], manager: 'priya', tz: IST },
  { key: 'sofia', name: 'Sofia Ramirez', title: 'Case Associate', entity: 'BAIS', roles: ['staff'], manager: 'jordan', tz: PT },
  { key: 'kevin', name: 'Kevin Tran', title: 'Paralegal', entity: 'BAIS', roles: ['staff'], manager: 'jordan', tz: PT },
  { key: 'meera', name: 'Meera Pillai', title: 'Case Associate', entity: 'BAIS', roles: ['staff'], manager: 'jordan', tz: IST },

  // USAIS has no manager: its lead escalates straight to the Founder's Office.
  { key: 'daniel', name: 'Daniel Brooks', title: 'Team Lead', entity: 'USAIS', roles: ['lead'], manager: 'rahul', tz: PT },
  { key: 'fatima', name: 'Fatima Sheikh', title: 'Case Associate', entity: 'USAIS', roles: ['staff'], manager: 'daniel', tz: PT },
  { key: 'arjun', name: 'Arjun Mehta', title: 'Case Associate', entity: 'USAIS', roles: ['staff'], manager: 'daniel', tz: IST },

  { key: 'kavita', name: 'Kavita Rao', title: 'Evaluations Manager', entity: 'IE', roles: ['manager'], manager: 'rahul', tz: IST },
  { key: 'sanjay', name: 'Sanjay Gupta', title: 'Evaluation Team Lead', entity: 'IE', roles: ['lead'], manager: 'kavita', tz: IST },
  { key: 'neha', name: 'Neha Joshi', title: 'Credential Evaluator', entity: 'IE', roles: ['staff'], manager: 'sanjay', tz: IST },
  { key: 'vikram', name: 'Vikram Singh', title: 'Credential Evaluator', entity: 'IE', roles: ['staff'], manager: 'sanjay', tz: IST },

  { key: 'rajesh', name: 'Rajesh Kumar', title: 'Engineering Manager', entity: 'EMBTEL', roles: ['manager'], manager: 'rahul', tz: IST },
  { key: 'deepa', name: 'Deepa Krishnan', title: 'Tech Lead', entity: 'EMBTEL', roles: ['lead'], manager: 'rajesh', tz: IST },
  { key: 'aditya', name: 'Aditya Bose', title: 'Developer', entity: 'EMBTEL', roles: ['staff'], manager: 'deepa', tz: IST },
  { key: 'sneha', name: 'Sneha Kulkarni', title: 'Developer', entity: 'EMBTEL', roles: ['staff'], manager: 'deepa', tz: IST },
  { key: 'ethan', name: 'Ethan Park', title: 'QA Engineer', entity: 'EMBTEL', roles: ['staff'], manager: 'deepa', tz: PT },

  { key: 'linda', name: 'Linda Chen', title: 'Accounting Manager', entity: 'BAAS', roles: ['manager'], manager: 'rahul', tz: PT },
  { key: 'michael', name: 'Michael Okafor', title: 'Senior Accountant (Team Lead)', entity: 'BAAS', roles: ['lead'], manager: 'linda', tz: PT },
  { key: 'pooja', name: 'Pooja Desai', title: 'Staff Accountant', entity: 'BAAS', roles: ['staff'], manager: 'michael', tz: IST },
  { key: 'carlos', name: 'Carlos Mendes', title: 'Bookkeeper', entity: 'BAAS', roles: ['staff'], manager: 'michael', tz: PT },
];

type Up = [hoursAgo: number, text: string, status?: 'in_progress' | 'blocked' | 'completed'];

interface Spec {
  title: string;
  to: string;
  by: string;
  priority: Priority;
  /** Created this many hours ago. */
  c: number;
  /** Due this many hours after creation. */
  d: number;
  instructions?: string;
  ups?: Up[];
  comments?: Array<[number, string, string]>;
  extend?: [number, string, number, string];
  reassign?: [number, string, string, string];
  acks?: Array<[number, string, number, string]>;
}

const OPEN_TASKS: Spec[] = [
  {
    title: 'RFE response — Fernandes H-1B: employer support letter',
    to: 'sofia', by: 'jordan', priority: 'critical', c: 30, d: 36,
    instructions: 'Draft the employer support letter addressing the specialty-occupation RFE. Use the template in the case folder.',
    ups: [[29, 'Pulled the RFE and the original petition. Starting the letter now.', 'in_progress'], [22, 'Outline done; waiting on job duties breakdown from the employer HR contact.']],
    comments: [[15, 'jordan', 'Sofia — the RFE deadline is Thursday. I need the support-letter draft today, please.']],
  },
  {
    title: 'StatCommand login failing for BAIS users',
    to: 'aditya', by: 'deepa', priority: 'critical', c: 9, d: 12,
    instructions: 'Users get a 500 after SSO redirect. Check the session store and the last deploy.',
    ups: [[8.5, 'Reproduced. Session cookie is dropped after redirect.', 'in_progress'], [6.5, 'Rolled back last deploy on staging; testing the fix.']],
  },
  {
    title: 'Parole request filing — Okonkwo family',
    to: 'ananya', by: 'priya', priority: 'critical', c: 5, d: 20,
    ups: [[4.5, 'Collected the medical letter; preparing the I-131 now.', 'in_progress']],
  },
  {
    title: 'Rush evaluation — Hernandez (university deadline)',
    to: 'neha', by: 'sanjay', priority: 'critical', c: 10, d: 14,
    ups: [[9, 'Transcripts received; starting the course-by-course.', 'in_progress']],
    acks: [[0.5, 'kavita', 2, 'Called Neha — the university portal was down. She is on it now and will update within the hour.']],
  },
  {
    title: 'Payroll tax deposit for BAIS — confirm EFTPS payment',
    to: 'carlos', by: 'linda', priority: 'critical', c: 3, d: 8,
    ups: [[2, 'Payment scheduled; waiting for EFTPS confirmation number.', 'in_progress']],
  },
  {
    title: 'I-130 package — Gomez family',
    to: 'rohit', by: 'priya', priority: 'high', c: 60, d: 96,
    ups: [[58, 'Started the forms and evidence checklist.', 'in_progress'], [20, 'Forms complete; marriage evidence index at 70%.']],
  },
  {
    title: 'RFE response outline — Chen L-1A',
    to: 'meera', by: 'jordan', priority: 'high', c: 80, d: 120,
    ups: [[78, 'Read the RFE. Three issues: managerial capacity, qualifying relationship, ability to pay.', 'in_progress'], [40, 'Requested org charts from the client.']],
  },
  {
    title: 'Consular interview prep pack — Ali family',
    to: 'fatima', by: 'daniel', priority: 'high', c: 100, d: 140,
    ups: [[99, 'Collected DS-260 confirmation and appointment letter.', 'in_progress'], [55, 'Mock interview questions drafted.']],
  },
  {
    title: 'Fix WhatsApp template rendering in StatCommand alerts',
    to: 'sneha', by: 'deepa', priority: 'high', c: 50, d: 72,
    ups: [[49, 'Variables render as {{1}} in previews; investigating.', 'in_progress'], [26, 'Found the escaping bug; writing tests.']],
  },
  {
    title: 'Course-by-course evaluation — Mensah transcripts',
    to: 'vikram', by: 'sanjay', priority: 'high', c: 122, d: 96,
    ups: [[110, 'Started; two institutions to verify.', 'in_progress'], [60, 'Verification email sent to the second institution.'], [10, 'Still waiting on the registrar; draft report ready otherwise.']],
    comments: [[8, 'kavita', 'Past due — what is blocking the final report?']],
  },
  {
    title: 'October bank reconciliation — BAIS operating account',
    to: 'pooja', by: 'michael', priority: 'high', c: 70, d: 100,
    ups: [[69, 'Pulled the ledger export.', 'in_progress'], [45, 'Reconciled through Oct 20.'], [30, 'Waiting for October statements from the bank — requested twice.', 'blocked']],
  },
  {
    title: 'TaskWatch WP-1: seed user directory for all entities',
    to: 'aditya', by: 'rajesh', priority: 'high', c: 40, d: 60,
    ups: [[39, 'Collected reporting lines from BAIS and BAAS.', 'in_progress'], [18, 'IE and USAIS done; Embtel pending.']],
  },
  {
    title: 'Biometrics appointment follow-up — Singh N-400',
    to: 'kevin', by: 'jordan', priority: 'normal', c: 150, d: 200,
    ups: [[140, 'Called USCIS contact centre; ticket opened.', 'in_progress'], [80, 'No response yet; will call again.']],
    comments: [[3, 'jordan', 'Kevin, please call the client about the biometrics notice.']],
    acks: [[2, 'jordan', 1, 'Spoke to Kevin; appointment notice expected Friday.']],
  },
  {
    title: 'Translate birth certificates — Lopez adjustment of status',
    to: 'sofia', by: 'jordan', priority: 'normal', c: 40, d: 120,
    ups: [[30, 'Sent to the certified translator; ETA two days.', 'in_progress']],
  },
  {
    title: 'Update client tracker after USCIS website change',
    to: 'arjun', by: 'daniel', priority: 'normal', c: 200, d: 250,
    ups: [[190, 'Mapped the new status names.', 'in_progress'], [80, 'Half the tracker updated.']],
  },
  {
    title: 'Quarterly QA sample — 20 evaluations',
    to: 'sanjay', by: 'kavita', priority: 'normal', c: 60, d: 200,
    ups: [[50, 'Pulled the sample list.', 'in_progress']],
  },
  {
    title: 'Upgrade Node runtime on StatCommand servers',
    to: 'ethan', by: 'deepa', priority: 'normal', c: 30, d: 150,
  },
  {
    title: 'Prepare 1099 vendor list for 2026',
    to: 'carlos', by: 'michael', priority: 'normal', c: 100, d: 150,
    ups: [[98, 'Exported vendor payments YTD.', 'in_progress'], [52, 'Flagged 6 vendors missing W-9s.']],
  },
  {
    title: 'Client intake notes — Patel family (EB-2 NIW)',
    to: 'priya', by: 'maria', priority: 'normal', c: 90, d: 110,
    ups: [[85, 'Intake call done; writing notes.', 'in_progress'], [20, 'Notes drafted; checking publication list.']],
  },
  {
    title: "Q4 operations summary for Founder's Office review",
    to: 'maria', by: 'rahul', priority: 'normal', c: 50, d: 100,
    ups: [[45, 'Collecting numbers from each case team.', 'in_progress']],
  },
  {
    title: 'Refresh FAQ page on asylum timelines',
    to: 'kevin', by: 'jordan', priority: 'low', c: 200, d: 300,
    ups: [[190, 'Collected the latest processing times.', 'in_progress']],
    comments: [[5, 'maria', 'Kevin, this has been quiet for a week. Please update it or hand it back.']],
  },
  {
    title: 'Clean up unused GoHighLevel webhooks',
    to: 'ethan', by: 'deepa', priority: 'low', c: 80, d: 250,
    ups: [[75, 'Listed 14 webhooks; 9 look unused.', 'in_progress']],
  },
  {
    title: 'Update evaluator style guide',
    to: 'neha', by: 'sanjay', priority: 'low', c: 50, d: 300,
    ups: [[48, 'Started with the grading-scale section.', 'in_progress']],
  },
  {
    title: 'EAD renewal — Kim',
    to: 'ananya', by: 'priya', priority: 'high', c: 30, d: 80,
    ups: [[28, 'Forms drafted.', 'in_progress'], [6, 'Client has not sent the updated passport copy; reminded by phone.', 'blocked']],
  },
  {
    title: 'Integrate WhatsApp Cloud API sandbox for TaskWatch',
    to: 'sneha', by: 'deepa', priority: 'high', c: 60, d: 100,
    ups: [[55, 'Created the Meta test app.', 'in_progress'], [12, 'Picked this up from Sneha; webhook verified in the sandbox.', 'in_progress']],
    reassign: [20, 'rajesh', 'aditya', 'Sneha moved to the StatCommand outage; Aditya takes over.'],
  },
  {
    title: 'Evidence index — Roberts O-1',
    to: 'rohit', by: 'priya', priority: 'normal', c: 120, d: 110,
    ups: [[100, 'Indexed the first 60 exhibits.', 'in_progress'], [30, 'Re-numbering after the new exhibits arrived.']],
    extend: [15, 'priya', 170, 'Client sent 40 more exhibits; the index must be rebuilt.'],
  },
  {
    title: 'Q3 sales tax filing — Embtel',
    to: 'pooja', by: 'michael', priority: 'high', c: 48, d: 46,
    ups: [[40, 'Pulled Q3 invoices.', 'in_progress'], [10, 'Return prepared; waiting on one state login.']],
  },
  {
    title: 'Archive closed 2025 case files',
    to: 'fatima', by: 'daniel', priority: 'low', c: 400, d: 300,
    ups: [[380, 'Started with A–F.', 'in_progress'], [200, 'A–M archived.'], [50, 'N–R archived.']],
  },
];

const DONE_TITLES: Record<string, string[]> = {
  BAIS: ['File I-765 — Alvarez', 'Fee receipt summary — Nguyen family', 'G-28 forms for new retainers', 'Case notes after interview — Torres', 'Cover letter — Osei I-485', 'Calendar RFE deadlines for October filings'],
  USAIS: ['Consular prep call — Rahman', 'Document checklist for new clients', 'Update intake form wording'],
  IE: ['Evaluate transcripts — Dimitrov', 'Final report — Haddad', 'Degree equivalency — Kowalski'],
  EMBTEL: ['Ship dashboard filters for StatCommand', 'Patch dependency vulnerabilities', 'Staging database backups', 'API docs for task webhooks'],
  BAAS: ['September credit card reconciliation', 'Quarterly P&L — Embtel', 'Vendor payments batch', 'State payroll returns — Q3'],
};

const DONE_PEOPLE = ['sofia', 'kevin', 'meera', 'ananya', 'rohit', 'fatima', 'arjun', 'neha', 'vikram', 'aditya', 'sneha', 'ethan', 'pooja', 'carlos', 'priya'];

const WINDOW: Record<Priority, number> = DEFAULT_RULES.windowsHours;

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Closed tasks over the last three weeks, so the accountability dashboard has history. */
function doneTasks(people: Map<string, Person>): Spec[] {
  const rand = rng(2026);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const used = new Map<string, number>();
  const out: Spec[] = [];
  for (const key of DONE_PEOPLE) {
    const p = people.get(key)!;
    const count = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < count; i++) {
      const titles = DONE_TITLES[p.entity]!;
      const n = used.get(p.entity) ?? 0;
      used.set(p.entity, n + 1);
      const priority = pick<Priority>(['high', 'normal', 'normal', 'low', 'critical']);
      const w = WINDOW[priority];
      const d = Math.round(w * (1.5 + rand() * 2.5));
      const c = Math.round(Math.max(d * 1.4, 60) + rand() * 380);
      const first = Math.max(0.3, w * (0.2 + rand() * 1.3));
      const late = rand() < 0.2;
      const doneAfter = Math.max(first + 1, d * (late ? 1.05 + rand() * 0.3 : 0.45 + rand() * 0.5));
      const doneAgo = Math.max(0.5, c - doneAfter);
      const mid = c - first - (c - first - doneAgo) / 2;
      out.push({
        title: titles[n % titles.length]!,
        to: key,
        by: p.manager!,
        priority,
        c,
        d,
        ups: [
          [c - first, 'Started.', 'in_progress'],
          [mid, 'Most of it is done; finishing the last items.'],
          [doneAgo, 'Completed and saved to the shared folder.', 'completed'],
        ],
      });
    }
  }
  return out;
}

async function insertDirectory(now: Date): Promise<Map<string, number>> {
  for (const [i, [id, name]] of ENTITIES.entries()) {
    await pool.query('insert into entities (id, name, sort, organization_id) values ($1,$2,$3,1)', [id, name, i]);
  }
  const ids = new Map<string, number>();
  for (const [i, p] of PEOPLE.entries()) {
    const email = p.email ?? `${p.name.replace(/^Dr\.\s*/, '').toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@example.com`;
    const phone = p.noPhone ? null : `+1415555${String(100 + i).padStart(4, '0')}`;
    const { rows } = await pool.query(
      `insert into users (name, email, phone, whatsapp, title, entity_id, roles, manager_id, time_zone, created_at, whatsapp_opt_in, organization_id)
       values ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,true,1) returning id`,
      [p.name, email, phone, p.title, p.entity, p.roles, p.manager ? ids.get(p.manager) : null, p.tz, now],
    );
    ids.set(p.key, rows[0].id);
  }
  await pool.query(`insert into sla_rules (organization_id, scope, config, updated_at) values (1, 'default', $1, $2)`, [JSON.stringify(DEFAULT_RULES), now]);
  invalidateDirectory();
  invalidateRules();
  return ids;
}

interface Event {
  at: Date;
  label: string;
  run: () => Promise<void>;
}

export async function seed(): Promise<void> {
  const realNow = new Date();
  const startedAt = Date.now();
  setDispatcherEnabled(false);
  const ids = await insertDirectory(new Date(realNow.getTime() - 30 * 24 * HOUR));
  const dir = await getDirectory(1);
  const person = (key: string): DirUser => dir.must(ids.get(key)!);
  const ago = (h: number) => new Date(realNow.getTime() - h * HOUR);

  const peopleByKey = new Map(PEOPLE.map((p) => [p.key, p]));
  const specs = [...OPEN_TASKS, ...doneTasks(peopleByKey)];
  const taskIds = new Map<Spec, number>();
  const events: Event[] = [];

  for (const s of specs) {
    const entity = peopleByKey.get(s.to)!.entity;
    events.push({
      at: ago(s.c),
      label: `create ${s.title}`,
      run: async () => {
        const id = await createTask(person(s.by), {
          title: s.title,
          description: '',
          instructions: s.instructions ?? '',
          category: 'Operations',
          priority: s.priority,
          assigneeId: ids.get(s.to)!,
          teamId: null,
          dueAt: ago(s.c - s.d),
          startAt: null,
          reviewRequired: false,
          parentId: null,
          target: null,
          unit: null,
          estimatedHours: 2,
          purpose: 'support',
        });
        taskIds.set(s, id);
      },
    });
    let assignee = s.to;
    const reassignAt = s.reassign?.[0];
    for (const [h, text, status] of s.ups ?? []) {
      const who = reassignAt != null && h < reassignAt ? s.reassign![2] : assignee;
      events.push({ at: ago(h), label: `update ${s.title}`, run: () => postUpdate(person(who), taskIds.get(s)!, { body: text, status }) });
    }
    for (const [h, by, text] of s.comments ?? []) {
      events.push({ at: ago(h), label: `comment ${s.title}`, run: async () => void (await addComment(person(by), taskIds.get(s)!, { body: text })) });
    }
    if (s.extend) {
      const [h, by, newD, reason] = s.extend;
      events.push({ at: ago(h), label: `extend ${s.title}`, run: () => changeDue(person(by), taskIds.get(s)!, ago(s.c - newD), reason) });
    }
    if (s.reassign) {
      const [h, by, to, reason] = s.reassign;
      events.push({ at: ago(h), label: `reassign ${s.title}`, run: () => reassignTask(person(by), taskIds.get(s)!, { toId: ids.get(to)!, reason }) });
      assignee = to;
    }
    for (const [h, by, level, note] of s.acks ?? []) {
      events.push({
        at: ago(h),
        label: `ack ${s.title}`,
        run: async () => {
          const { rows } = await pool.query('select id from escalations where task_id = $1 and level = $2 and cleared_at is null', [taskIds.get(s), level]);
          if (rows[0]) await acknowledge(person(by), rows[0].id, note);
          else console.warn(`  (no active L${level} to acknowledge on "${s.title}")`);
        },
      });
    }
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  // Replay history: run each event at its own time, and the engine every 30 minutes between them.
  const start = events[0]!.at.getTime();
  let i = 0;
  for (let t = start; t <= realNow.getTime(); t += 30 * MINUTE) {
    while (i < events.length && events[i]!.at.getTime() <= t) {
      const e = events[i++]!;
      clock.setFixed(e.at);
      await runEngine();
      try {
        await e.run();
      } catch (err) {
        console.warn(`  skipped "${e.label}": ${(err as Error).message}`);
      }
    }
    clock.setFixed(new Date(t));
    await runEngine();
  }
  clock.setFixed(realNow);
  await runEngine();

  // Recurring schedules (FR-7) start from today (the monthly one from the 5th of this month).
  const today = realNow.toISOString().slice(0, 10);
  const base = { description: '', teamId: null, reviewRequired: false, interval: 1, weekdays: [] as number[], endDate: null, target: null, unit: null, estimatedHours: 1, purpose: 'support' as const };
  await saveRecurring(person('maria'), null, {
    ...base, title: 'Weekly case review — Family team', category: 'Client delivery', assigneeId: ids.get('priya')!, priority: 'normal',
    description: 'Review every open family-based case: next action, owner and deadline.', frequency: 'weekly', weekdays: [1], startDate: today, dueHour: 18,
  });
  await saveRecurring(person('linda'), null, {
    ...base, title: 'Monthly payroll filings — all entities', category: 'Finance', assigneeId: ids.get('pooja')!, priority: 'high',
    description: 'File payroll tax returns and deposits for every entity; attach confirmations.', frequency: 'monthly', startDate: today.slice(0, 8) + '05', dueHour: 10,
  });
  await saveRecurring(person('deepa'), null, {
    ...base, title: 'Daily deployment checklist', category: 'IT & Systems', assigneeId: ids.get('ethan')!, priority: 'low',
    description: 'Confirm backups, error rates and pending migrations before any deploy.', frequency: 'daily', startDate: today, dueHour: 17,
  });
  clock.setFixed(null);

  // History has already happened: mark past WhatsApp/email as simulated deliveries and old in-app alerts as read.
  await pool.query(
    `update notifications set status = 'simulated', sent_at = greatest(send_after, created_at), attempts = 1
      where channel <> 'inapp' and status in ('pending','held') and send_after <= $1`,
    [realNow],
  );
  await pool.query(`update notifications set read_at = created_at + interval '1 hour' where channel = 'inapp' and created_at < $1`, [ago(12)]);
  await runChainCheck('nightly');
  setDispatcherEnabled(true);

  const counts = await pool.query(
    `select (select count(*) from tasks) as tasks, (select count(*) from activity_log) as log, (select count(*) from escalations) as esc,
            (select count(*) from notifications) as notes`,
  );
  const c = counts.rows[0];
  console.log(
    `Seeded ${PEOPLE.length} people, ${c.tasks} tasks, ${c.log} log rows, ${c.esc} escalations, ${c.notes} alerts in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`,
  );
  console.log(`Sign in as Rahul Kashyap (${PEOPLE[1]!.email}) to see the Chief of Staff view.`);
}

async function reset(): Promise<void> {
  if (config.isProd) throw new Error('Refusing to reset a production database.');
  await pool.query('drop schema public cascade');
  await pool.query('create schema public');
  await migrate();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const wantsReset = process.argv.includes('--reset');
  (async () => {
    if (config.isProd) throw new Error('Refusing to load demo data into production. Use `npm run db:bootstrap`.');
    if (wantsReset) await reset();
    else await migrate();
    const { rows } = await pool.query('select count(*) as n from users');
    if (rows[0].n > 0) throw new Error('The directory already has people. Run `npm run db:seed -- --reset` to wipe and reseed.');
    await seed();
  })()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
}
