// Deterministic fictional organization: Embtel Solutions. Same seed → same data (relative to "now").
import {
  CATEGORIES,
  DAY,
  DEFAULT_RULES,
  HOUR,
  NOTIFICATION_LABEL,
} from "../../constants";
import type {
  Db,
  NotificationPrefs,
  NotificationType,
  Permission,
  Priority,
  Role,
  Status,
  Task,
  User,
} from "../../types";
import { DEFAULT_ROLE_PERMISSIONS } from "@taskwatch/shared/permissions";
import { DEFAULT_SETTINGS } from "@taskwatch/shared/settings";
import {
  createTaskRecord,
  iso,
  logActivity,
  nextId,
  processEscalations,
  processRecurrences,
  recordAssignment,
  userName,
} from "../core";
import { isoDay } from "../engine/recurrence";
import { processDigests, releaseHeld } from "../channels";

export const DB_VERSION = 7;

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The default role matrix lives in the shared rules module (D-29 applied: leads do not reassign by default).
export { DEFAULT_ROLE_PERMISSIONS };

// One set of default preferences for server and prototype (shared/notifications.ts).
import { defaultPrefs } from "@taskwatch/shared/notifications";
export { defaultPrefs };

const ZONES: Record<string, string> = {
  Boston: "America/New_York",
  Austin: "America/Chicago",
  Denver: "America/Denver",
  Remote: "America/Los_Angeles",
};
/** People without a WhatsApp number, to show "skipped" deliveries. */
const NO_WHATSAPP = new Set(["u-s4", "u-s12", "u-s17"]);

type P = [
  id: string,
  name: string,
  title: string,
  role: Role,
  manager: string | null,
  team: string | null,
  location: string,
];
const PEOPLE: P[] = [
  ["u-ceo", "Nadia Rahman", "Chief Executive Officer", "ceo", null, null, "Boston"],
  ["u-cos", "Elena Marsh", "Chief of Staff", "cos", "u-ceo", null, "Boston"],
  [
    "u-m1",
    "Victor Okafor",
    "Head of Operations",
    "manager",
    "u-cos",
    null,
    "Boston",
  ],
  [
    "u-m2",
    "Priya Raman",
    "Finance Director",
    "manager",
    "u-cos",
    null,
    "Austin",
  ],
  [
    "u-m3",
    "Hannah Ilves",
    "Client Services Director",
    "manager",
    "u-cos",
    null,
    "Denver",
  ],
  ["u-l1", "Marcus Bell", "Logistics Lead", "lead", "u-m1", "t-log", "Boston"],
  [
    "u-l2",
    "Grace Tanaka",
    "Facilities Lead",
    "lead",
    "u-m1",
    "t-fac",
    "Boston",
  ],
  ["u-l3", "Omar Haddad", "Accounts Lead", "lead", "u-m2", "t-acc", "Austin"],
  ["u-l4", "Lucia Ferreira", "Payroll Lead", "lead", "u-m2", "t-pay", "Austin"],
  [
    "u-l5",
    "Daniel Novak",
    "Onboarding Lead",
    "lead",
    "u-m3",
    "t-onb",
    "Denver",
  ],
  ["u-l6", "Aisha Bello", "Support Lead", "lead", null, "t-sup", "Remote"],
  [
    "u-s1",
    "Sam Whitfield",
    "Logistics Coordinator",
    "staff",
    "u-l1",
    "t-log",
    "Boston",
  ],
  [
    "u-s2",
    "Nina Kovac",
    "Inventory Analyst",
    "staff",
    "u-l1",
    "t-log",
    "Boston",
  ],
  [
    "u-s3",
    "Theo Mensah",
    "Dispatch Specialist",
    "staff",
    "u-l1",
    "t-log",
    "Boston",
  ],
  [
    "u-s4",
    "Rosa Delgado",
    "Facilities Coordinator",
    "staff",
    "u-l2",
    "t-fac",
    "Boston",
  ],
  [
    "u-s5",
    "Ivan Petrov",
    "Maintenance Planner",
    "staff",
    "u-l2",
    "t-fac",
    "Boston",
  ],
  [
    "u-s6",
    "Mei Chen",
    "Accounts Payable Specialist",
    "staff",
    "u-l3",
    "t-acc",
    "Austin",
  ],
  [
    "u-s7",
    "Jonah Reyes",
    "Accounts Receivable Specialist",
    "staff",
    "u-l3",
    "t-acc",
    "Austin",
  ],
  [
    "u-s8",
    "Fatima Zahra",
    "Reconciliation Analyst",
    "staff",
    "u-l3",
    "t-acc",
    "Austin",
  ],
  [
    "u-s9",
    "Ben Adler",
    "Payroll Specialist",
    "staff",
    "u-l4",
    "t-pay",
    "Austin",
  ],
  [
    "u-s10",
    "Chloe Martin",
    "Benefits Administrator",
    "staff",
    "u-l4",
    "t-pay",
    "Austin",
  ],
  [
    "u-s11",
    "Kwame Asante",
    "Onboarding Specialist",
    "staff",
    "u-l5",
    "t-onb",
    "Denver",
  ],
  [
    "u-s12",
    "Laura Byrne",
    "Implementation Analyst",
    "staff",
    "u-l5",
    "t-onb",
    "Denver",
  ],
  [
    "u-s13",
    "Ravi Shah",
    "Training Coordinator",
    "staff",
    "u-l5",
    "t-onb",
    "Denver",
  ],
  [
    "u-s14",
    "Elif Demir",
    "Support Specialist",
    "staff",
    "u-l6",
    "t-sup",
    "Remote",
  ],
  [
    "u-s15",
    "Owen Price",
    "Support Specialist",
    "staff",
    "u-l6",
    "t-sup",
    "Remote",
  ],
  [
    "u-s16",
    "Sara Lindqvist",
    "Escalations Analyst",
    "staff",
    "u-l6",
    "t-sup",
    "Remote",
  ],
  [
    "u-s17",
    "Diego Alvarez",
    "Fleet Coordinator",
    "staff",
    "u-l1",
    "t-log",
    "Boston",
  ],
  ["u-s18", "Yuki Sato", "Payroll Analyst", "staff", "u-l4", "t-pay", "Austin"],
  [
    "u-s19",
    "Peter Grant",
    "Facilities Technician",
    "staff",
    "u-l2",
    "t-fac",
    "Boston",
  ],
  [
    "u-s20",
    "Amara Obi",
    "Client Success Associate",
    "staff",
    "u-l5",
    "t-onb",
    "Denver",
  ],
];

const TITLES: Record<string, string[]> = {
  "t-log": [
    "Reconcile Q4 carrier invoices",
    "Audit warehouse cycle counts",
    "Renegotiate courier SLA",
    "Plan holiday dispatch rota",
    "Update fleet maintenance log",
    "Consolidate vendor shipping rates",
  ],
  "t-fac": [
    "Schedule HVAC inspection",
    "Renew building access badges",
    "Prepare fire-drill report",
    "Quote for meeting room refit",
    "Replace floor 3 workstations",
  ],
  "t-acc": [
    "Close October payables",
    "Chase overdue receivables > 60 days",
    "Reconcile bank feeds",
    "Prepare vendor 1099 list",
    "Review expense policy exceptions",
    "Accrual schedule for year-end",
  ],
  "t-pay": [
    "Run bi-weekly payroll",
    "Verify benefits enrollment changes",
    "File state withholding returns",
    "Audit overtime approvals",
    "Update PTO accrual rules",
  ],
  "t-onb": [
    "Onboard Halcyon Labs account",
    "Draft implementation plan for Brightwater",
    "Run admin training session",
    "Migrate client data templates",
    "Prepare go-live checklist",
  ],
  "t-sup": [
    "Clear backlog of priority tickets",
    "Write macro for billing questions",
    "Weekly CSAT summary",
    "Root-cause review: login outage",
    "Update support knowledge base",
  ],
  mgmt: [
    "Quarterly headcount plan",
    "Department budget variance review",
    "Vendor risk assessment",
    "Board pack: operations section",
    "Process audit: escalation handling",
  ],
};

export function createSeed(nowMs: number): Db {
  const rand = rng(20261103);
  const pick = <T>(arr: readonly T[]): T =>
    arr[Math.floor(rand() * arr.length)]!;
  const between = (a: number, b: number) => a + rand() * (b - a);

  const db: Db = {
    version: DB_VERSION,
    seededAt: iso(nowMs),
    clockOffsetMs: 0,
    seq: 1,
    users: [],
    departments: [
      { id: "d-ops", name: "Operations", headId: "u-m1" },
      { id: "d-fin", name: "Finance", headId: "u-m2" },
      { id: "d-cs", name: "Client Services", headId: "u-m3" },
    ],
    teams: [
      { id: "t-log", name: "Logistics", departmentId: "d-ops", leadId: "u-l1" },
      {
        id: "t-fac",
        name: "Facilities",
        departmentId: "d-ops",
        leadId: "u-l2",
      },
      { id: "t-acc", name: "Accounts", departmentId: "d-fin", leadId: "u-l3" },
      { id: "t-pay", name: "Payroll", departmentId: "d-fin", leadId: "u-l4" },
      { id: "t-onb", name: "Onboarding", departmentId: "d-cs", leadId: "u-l5" },
      { id: "t-sup", name: "Support", departmentId: "d-cs", leadId: "u-l6" },
    ],
    tasks: [],
    activities: [],
    comments: [],
    updates: [],
    attachments: [],
    reviews: [],
    extensions: [],
    assignments: [],
    escalations: [],
    notifications: [],
    deliveries: [],
    audit: [],
    recurrences: [],
    rolePermissions: structuredClone(DEFAULT_ROLE_PERMISSIONS),
    rules: structuredClone(DEFAULT_RULES),
    settings: structuredClone(DEFAULT_SETTINGS),
    prefs: {},
    passwordResets: [],
  };

  PEOPLE.forEach(([id, name, title, role, managerId, teamId, location], i) => {
    const first = name.split(" ")[0]!.toLowerCase();
    const last = name.split(" ").slice(-1)[0]!.toLowerCase();
    db.users.push({
      id,
      name,
      email: `${first}.${last}@meridian.example`,
      title,
      role,
      managerId,
      teamId,
      status: id === "u-s19" ? "inactive" : "active",
      joinedAt: iso(nowMs - (90 + i * 37) * DAY),
      location,
      phone: `+1 555 01${String(10 + i).padStart(2, "0")}`,
      // Fictional 555 numbers: WhatsApp would reject these; fine for simulation.
      whatsapp: NO_WHATSAPP.has(id) ? null : `+1555010${String(10 + i).padStart(2, "0")}`,
      whatsappOptIn: !NO_WHATSAPP.has(id) && id !== "u-s10",
      timezone: ZONES[location] ?? "America/New_York",
    });
    db.prefs[id] = defaultPrefs();
  });

  const staff = db.users.filter(
    (u) => u.role === "staff" && u.status === "active",
  );
  const leads = db.users.filter((u) => u.role === "lead");
  const managers = db.users.filter((u) => u.role === "manager");
  const giverOf = (u: User) => u.managerId ?? "u-cos";

  type Plan = {
    status: Status;
    priority: Priority;
    ageH: number;
    dueInH: number;
    silentH: number;
    ack: boolean;
    review: boolean;
    ext?: "pending" | "approved" | "rejected";
    round?: number;
  };

  const plans: { assignee: User; plan: Plan }[] = [];
  const priorities: Priority[] = [
    "critical",
    "high",
    "high",
    "normal",
    "normal",
    "normal",
    "low",
    "low",
  ];
  const statusMix: Status[] = [
    "assigned",
    "in_progress",
    "in_progress",
    "in_progress",
    "submitted",
    "changes_requested",
    "completed",
    "completed",
    "completed",
    "completed",
    "reopened",
    "cancelled",
    "draft",
  ];

  const people = [
    ...staff,
    ...staff,
    ...staff,
    ...staff,
    ...leads,
    ...managers,
  ];
  for (let i = 0; i < 112; i++) {
    const assignee = people[i % people.length]!;
    const status = pick(statusMix);
    const priority = pick(priorities);
    const win = DEFAULT_RULES.windowsHours[priority];
    const ageH = between(win * 0.5, 24 * 24);
    // Silence spread: on track → L3 range.
    const silentH = Math.min(
      ageH,
      win * pick([0.2, 0.5, 0.8, 1.1, 1.6, 2.2, 3.4]),
    );
    const dueInH = pick([-100, -40, -10, 6, 20, 48, 96, 200]);
    plans.push({
      assignee,
      plan: {
        status,
        priority,
        ageH,
        dueInH,
        silentH,
        ack: rand() > 0.35,
        review:
          rand() > 0.4 ||
          status === "submitted" ||
          status === "changes_requested",
        ext:
          rand() > 0.88
            ? pick(["pending", "approved", "rejected"] as const)
            : undefined,
        round: status === "changes_requested" ? 1 : 0,
      },
    });
  }

  for (const { assignee, plan } of plans) {
    const giverId = giverOf(assignee);
    const teamId = assignee.teamId;
    const titles = TITLES[assignee.teamId ?? ""] ?? TITLES.mgmt!;
    const createdMs = nowMs - plan.ageH * HOUR;
    const dueMs =
      plan.status === "completed" || plan.status === "cancelled"
        ? createdMs + between(24, 240) * HOUR
        : nowMs + plan.dueInH * HOUR;
    const task = createTaskRecord(
      db,
      {
        title: pick(titles),
        description:
          "Deliver the outcome described in the title, and record progress in TaskWatch so the team can see where it stands. Attach supporting files where useful.",
        instructions:
          rand() > 0.5
            ? "Coordinate with the owning team before making changes. Flag blockers early."
            : "",
        category: pick(CATEGORIES),
        priority: plan.priority,
        assigneeId: assignee.id,
        teamId,
        dueAt: iso(Math.max(dueMs, createdMs + 2 * HOUR)),
        reviewRequired: plan.review,
        draft: plan.status === "draft",
      },
      giverId,
      iso(createdMs),
    );
    if (plan.status === "draft") continue;
    seedLifecycle(db, task, plan, createdMs, nowMs, rand);
  }

  // A few tasks assigned to people whose giver later left the team — reassignment history.
  for (const t of db.tasks
    .filter((x) => x.status === "in_progress")
    .slice(0, 4)) {
    const peers = staff.filter(
      (s) =>
        s.managerId ===
          db.users.find((u) => u.id === t.assigneeId)?.managerId &&
        s.id !== t.assigneeId,
    );
    const to = peers[0];
    if (!to) continue;
    const at = iso(Date.parse(t.createdAt) + 6 * HOUR);
    recordAssignment(
      db,
      t,
      t.assigneeId,
      to.id,
      t.assignedBy,
      at,
      "Rebalanced workload",
    );
    t.assigneeId = to.id;
  }

  // Recurring definitions.
  const start = isoDay(nowMs - 14 * DAY);
  db.recurrences.push(
    {
      id: "rec-1",
      title: "Daily cash position report",
      description: "Post the daily cash position to the finance channel.",
      category: "Finance",
      priority: "high",
      assigneeId: "u-s8",
      createdBy: "u-l3",
      teamId: "t-acc",
      reviewRequired: false,
      frequency: "daily",
      interval: 1,
      weekdays: [],
      startDate: isoDay(nowMs - 3 * DAY),
      endDate: null,
      dueHour: 17,
      active: true,
      createdAt: iso(nowMs - 3 * DAY),
    },
    {
      id: "rec-2",
      title: "Weekly support CSAT summary",
      description: "Summarize CSAT and top contact drivers.",
      category: "Reporting",
      priority: "normal",
      assigneeId: "u-s14",
      createdBy: "u-l6",
      teamId: "t-sup",
      reviewRequired: true,
      frequency: "weekly",
      interval: 1,
      weekdays: [1],
      startDate: start,
      endDate: null,
      dueHour: 18,
      active: true,
      createdAt: iso(nowMs - 14 * DAY),
    },
    {
      id: "rec-3",
      title: "Monthly payroll reconciliation",
      description: "Reconcile payroll register against GL.",
      category: "Finance",
      priority: "critical",
      assigneeId: "u-s9",
      createdBy: "u-l4",
      teamId: "t-pay",
      reviewRequired: true,
      frequency: "monthly",
      interval: 1,
      weekdays: [],
      startDate: isoDay(nowMs - 40 * DAY),
      endDate: null,
      dueHour: 16,
      active: true,
      createdAt: iso(nowMs - 40 * DAY),
    },
    {
      id: "rec-4",
      title: "Facilities walk-through",
      description: "Walk each floor and log issues.",
      category: "Facilities",
      priority: "low",
      assigneeId: "u-s4",
      createdBy: "u-l2",
      teamId: "t-fac",
      reviewRequired: false,
      frequency: "interval",
      interval: 3,
      weekdays: [],
      startDate: isoDay(nowMs - 9 * DAY),
      endDate: isoDay(nowMs + 60 * DAY),
      dueHour: 15,
      active: false,
      createdAt: iso(nowMs - 9 * DAY),
    },
  );

  // Historical audit entries for admin activity.
  const adminLog: [
    number,
    string,
    string,
    string,
    string | null,
    string | null,
  ][] = [
    [30, "staff.created", "user", "u-s20", null, "Amara Obi"],
    [
      21,
      "role.permissions_changed",
      "role",
      "lead",
      "Without: Approve extensions",
      "With: Approve extensions",
    ],
    [12, "staff.deactivated", "user", "u-s19", "active", "inactive"],
    [
      8,
      "policy.updated",
      "policy",
      "default",
      "Critical window 6 h",
      "Critical window 4 h",
    ],
    [3, "staff.manager_changed", "user", "u-l6", "Hannah Ilves", "No manager"],
  ];
  for (const [daysAgo, action, targetType, targetId, prev, next] of adminLog) {
    db.audit.push({
      id: nextId(db, "aud"),
      at: iso(nowMs - daysAgo * DAY),
      actorId: "u-cos",
      action,
      targetType: targetType as "user",
      targetId,
      taskId: null,
      prev,
      next,
      source: "ui",
      context: "Seeded history",
    });
  }

  processRecurrences(db, nowMs);
  // Run the escalation engine across the seeded history so events match the rules.
  processEscalations(db, nowMs);
  releaseHeld(db, nowMs);
  processDigests(db, nowMs, (p) => nextId(db, p));
  // Some escalations have already been acknowledged.
  for (const e of db.escalations.filter(
    (x) => x.status === "active" && x.level >= 1,
  )) {
    if (rand() > 0.6) {
      e.status = "acknowledged";
      e.ackBy = e.recipientIds[0] ?? null;
      e.ackAt = iso(
        Math.min(nowMs, Date.parse(e.at) + (0.5 + rand() * 7) * HOUR),
      );
      logActivity(
        db,
        e.taskId,
        "escalation_acknowledged",
        e.ackBy,
        `Acknowledged L${e.level} escalation`,
        e.ackAt,
      );
    }
  }
  // Older notifications are read.
  for (const n of db.notifications)
    if (Date.parse(n.at) < nowMs - 2 * DAY) n.read = true;
  db.activities.sort((a, b) => a.at.localeCompare(b.at));
  return db;
}

function seedLifecycle(
  db: Db,
  task: Task,
  plan: {
    status: Status;
    silentH: number;
    ack: boolean;
    ext?: "pending" | "approved" | "rejected";
    round?: number;
  },
  createdMs: number,
  nowMs: number,
  rand: () => number,
): void {
  const a = task.assigneeId;
  const g = task.assignedBy;
  let t = createdMs;
  const step = (h: number) => (t = Math.min(nowMs - 60_000, t + h * HOUR));
  const closedLike =
    plan.status === "completed" ||
    plan.status === "reopened" ||
    plan.status === "cancelled";
  const lastUpdateMs = closedLike
    ? createdMs + (nowMs - createdMs) * (0.25 + rand() * 0.35)
    : nowMs - plan.silentH * HOUR;

  if (plan.ack) {
    step(between(rand, 0.2, 3));
    task.acknowledgedAt = iso(t);
    logActivity(
      db,
      task.id,
      "acknowledged",
      a,
      "Acknowledged the task",
      task.acknowledgedAt,
    );
  }
  if (plan.status === "assigned") {
    task.clockStartedAt = task.createdAt;
    return;
  }
  if (plan.status === "cancelled") {
    step(between(rand, 4, 30));
    task.status = "cancelled";
    task.cancelReason = "Superseded by a consolidated request";
    task.updatedAt = iso(t);
    logActivity(
      db,
      task.id,
      "cancelled",
      g,
      "Cancelled: Superseded by a consolidated request",
      iso(t),
    );
    return;
  }
  step(between(rand, 0.5, 4));
  logActivity(db, task.id, "status_changed", a, "Started work", iso(t), {
    from: "assigned",
    to: "in_progress",
  });

  const msgs = [
    "Gathered the inputs and started the first pass.",
    "Halfway there — waiting on one figure from the vendor.",
    "Drafted the main deliverable, reviewing details now.",
    "Resolved the open question with the owning team.",
    "Final checks in progress.",
  ];
  const n = 1 + Math.floor(rand() * 3);
  let percent = 0;
  const updateTimes: number[] = [];
  for (let i = 0; i < n; i++)
    updateTimes.push(
      Math.min(
        lastUpdateMs,
        createdMs + ((i + 1) / (n + 1)) * (lastUpdateMs - createdMs),
      ),
    );
  updateTimes.push(lastUpdateMs);
  for (const [i, ut] of updateTimes.entries()) {
    if (ut <= t) continue;
    t = ut;
    percent = Math.min(
      plan.status === "completed" ? 100 : 90,
      percent + 15 + Math.floor(rand() * 25),
    );
    const u = {
      id: nextId(db, "upd"),
      taskId: task.id,
      authorId: a,
      message: msgs[i % msgs.length]!,
      percent,
      at: iso(t),
      attachmentIds: [] as string[],
    };
    if (i === 0 && rand() > 0.5) {
      const att = {
        id: nextId(db, "att"),
        taskId: task.id,
        name: "working-notes.pdf",
        size: 184_320,
        mime: "application/pdf",
        uploadedBy: a,
        at: iso(t),
        context: "progress" as const,
      };
      db.attachments.push(att);
      u.attachmentIds.push(att.id);
    }
    db.updates.push(u);
    logActivity(
      db,
      task.id,
      "progress",
      a,
      `Progress update · ${percent}%`,
      iso(t),
      { percent },
    );
    task.clockStartedAt = iso(t);
    task.progress = percent;
  }
  if (task.clockStartedAt === task.createdAt)
    task.clockStartedAt = task.createdAt;

  if (rand() > 0.45) {
    const cAt = iso(Math.min(nowMs - 30_000, t + 0.5 * HOUR));
    db.comments.push({
      id: nextId(db, "cmt"),
      taskId: task.id,
      authorId: g,
      body: "Thanks — please keep the update cadence; flag anything blocking.",
      at: cAt,
      editedAt: null,
      parentId: null,
      deleted: false,
    });
    logActivity(db, task.id, "comment", g, "Commented", cAt);
  }

  if (plan.ext) {
    const at = iso(Math.min(nowMs - 20_000, t + HOUR));
    const requested = iso(Date.parse(task.dueAt) + 72 * HOUR);
    const ext = {
      id: nextId(db, "ext"),
      taskId: task.id,
      requestedBy: a,
      at,
      currentDue: task.dueAt,
      requestedDue: requested,
      reason: "Waiting on third-party data that arrives later than planned.",
      info: "",
      status: plan.ext,
      decidedBy: null as string | null,
      decidedAt: null as string | null,
      decisionNote: null as string | null,
    };
    logActivity(
      db,
      task.id,
      "extension_requested",
      a,
      `Requested extension to ${requested.slice(0, 10)}`,
      at,
    );
    if (plan.ext !== "pending") {
      ext.decidedBy = g;
      ext.decidedAt = iso(Math.min(nowMs - 10_000, Date.parse(at) + 3 * HOUR));
      ext.decisionNote =
        plan.ext === "approved"
          ? "Approved — dependency confirmed."
          : "Please complete with the data available.";
      logActivity(
        db,
        task.id,
        "extension_decided",
        g,
        `Extension ${plan.ext}`,
        ext.decidedAt,
      );
      if (plan.ext === "approved") {
        logActivity(
          db,
          task.id,
          "due_changed",
          g,
          `Due date moved to ${requested.slice(0, 10)}`,
          ext.decidedAt,
          { from: task.dueAt, to: requested },
        );
        task.dueAt = requested;
      }
    }
    db.extensions.push(ext);
  }

  const submit = (round: number) => {
    step(between(rand, 0.5, 3));
    db.reviews.push({
      id: nextId(db, "rev"),
      taskId: task.id,
      round,
      submittedBy: a,
      submittedAt: iso(t),
      note:
        round > 1
          ? "Addressed the requested changes."
          : "Ready for review — summary attached.",
      reviewerId: null,
      decision: null,
      decidedAt: null,
      comment: null,
    });
    logActivity(
      db,
      task.id,
      "review_submitted",
      a,
      `Submitted for review (round ${round})`,
      iso(t),
    );
  };
  const decide = (decision: "approved" | "changes_requested") => {
    step(between(rand, 1, 8));
    const r = db.reviews.filter((x) => x.taskId === task.id).at(-1)!;
    Object.assign(r, {
      reviewerId: task.reviewerId,
      decision,
      decidedAt: iso(t),
      comment:
        decision === "approved"
          ? "Looks good. Approved."
          : "Please add the supporting reconciliation and resubmit.",
    });
    logActivity(
      db,
      task.id,
      "review_decided",
      task.reviewerId,
      decision === "approved" ? "Approved the submission" : "Requested changes",
      iso(t),
    );
  };

  switch (plan.status) {
    case "in_progress":
      task.status = "in_progress";
      break;
    case "submitted":
      submit(1);
      task.status = "submitted";
      break;
    case "changes_requested":
      submit(1);
      decide("changes_requested");
      task.status = "changes_requested";
      task.clockStartedAt = iso(t);
      break;
    case "completed":
    case "reopened":
      if (task.reviewRequired) {
        submit(1);
        if (rand() > 0.6) {
          decide("changes_requested");
          submit(2);
        }
        decide("approved");
      }
      task.status = "completed";
      task.progress = 100;
      task.completedAt = iso(t);
      logActivity(
        db,
        task.id,
        "completed",
        task.reviewRequired ? task.reviewerId : a,
        "Completed",
        iso(t),
      );
      notifyDone(db, task, t);
      if (plan.status === "reopened") {
        step(between(rand, 2, 24));
        task.status = "reopened";
        task.completedAt = null;
        task.clockStartedAt = iso(t);
        task.dueAt = iso(Math.max(Date.parse(task.dueAt), nowMs + 48 * HOUR));
        logActivity(
          db,
          task.id,
          "reopened",
          g,
          "Reopened: Figures need to be restated for the revised forecast",
          iso(t),
        );
      }
      break;
  }
  task.updatedAt = iso(Math.max(t, Date.parse(task.clockStartedAt)));
}

function notifyDone(db: Db, task: Task, t: number) {
  db.notifications.push({
    id: nextId(db, "ntf"),
    userId: task.assignedBy,
    type: "completed",
    title: `${task.id} completed`,
    body: `${task.title} by ${userName(db, task.assigneeId)}`,
    taskId: task.id,
    at: iso(t),
    read: true,
    emailSimulated: false,
  });
}

function between(rand: () => number, a: number, b: number) {
  return a + rand() * (b - a);
}
