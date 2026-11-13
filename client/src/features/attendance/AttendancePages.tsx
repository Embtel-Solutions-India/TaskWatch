// ADR-0015 attendance. The GM marks their members (the CoS: the Founder's Office); everyone with attendance sees
// their own month. Today and past days only (D-163). Unmarked days show as absent, with their own look (D-157).
import { useMemo, useState } from 'react';
import { Avatar, Banner, Button, Card, Dialog, Empty, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tabs, Tag } from '../../components/ui';
import { useAction, useApi, useAuth } from '../../hooks';
import { getOrg } from '../../services/api/admin';
import { listAttendance, markAttendance, myAttendance, STATUS_LABEL, STATUS_TONE, todayIn, type AttendanceStatus, type MarkInput } from '../../services/api/attendance';
import { BACKEND } from '../../services/http';
import { downloadCsv } from '../../utils/format';

/** What the GM can pick; half days say which half they were away (owner, 2026-11-13). */
const CHOICES: { value: string; label: string; mark: Pick<MarkInput, 'status' | 'half'> }[] = [
  { value: 'present', label: 'Present', mark: { status: 'present' } },
  { value: 'absent', label: 'Absent', mark: { status: 'absent' } },
  { value: 'half-first', label: 'Half day – away morning', mark: { status: 'half_day', half: 'first' } },
  { value: 'half-second', label: 'Half day – away afternoon', mark: { status: 'half_day', half: 'second' } },
  { value: 'leave', label: 'Leave', mark: { status: 'leave' } },
];
const choice = (v: string) => CHOICES.find((c) => c.value === v)!.mark;
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

function StatusTag({ status }: { status: AttendanceStatus }) {
  // D-157: shown as absent, dashed, so a gap is visible.
  return status === 'unmarked' ? <span className="att-unmarked" title="Not marked">Absent</span> : <Tag tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Tag>;
}

export function AttendancePage() {
  const auth = useAuth();
  const [tab, setTab] = useState<'day' | 'month'>('day');
  const [picked, setDay] = useState<string | null>(null);
  // Until the server says what today is in the members' vertical, the viewer's own zone stands in.
  const [serverToday, setServerToday] = useState<string | null>(null);
  const today = serverToday ?? todayIn(auth.bootstrap?.user.timezone ?? 'UTC');
  const day = picked ?? today;
  const [teamId, setTeamId] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [range, setRange] = useState(false);
  const from = tab === 'day' ? day : monthStart(day);
  const to = tab === 'day' ? day : new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).toISOString().slice(0, 10); // the whole month
  const q = useApi(['attendance', from, to, teamId, userId, status], () => (BACKEND === 'server' ? listAttendance({ from, to, teamId, userId, status }) : null));
  if (q.data && q.data.today !== serverToday) setServerToday(q.data.today);
  const org = useApi(['org'], getOrg);
  const mark = useAction(markAttendance, { success: (r) => `${r.updated} day${r.updated === 1 ? '' : 's'} marked.` });
  if (BACKEND !== 'server') return <div className="page"><PageHeader title="Attendance" /><Card><Empty icon="calendar" title="Attendance needs the server backend." /></Card></div>;
  if (q.error) return <ErrorState error={q.error} />;
  const data = q.data;
  const people = data?.people ?? [];
  const teams = (org.data?.teams ?? []).filter((t) => people.some((p) => String(p.teamId) === t.id));
  const dayOf = (uid: number, d: string) => data?.days.find((x) => x.userId === uid && x.day === d);
  const csv = () =>
    downloadCsv(`attendance-${from}-to-${to}.csv`, [
      ['Person', 'Day', 'Status', 'Away from', 'Away to'],
      ...(data?.days ?? []).map((d) => [people.find((p) => p.id === d.userId)?.name ?? d.userId, d.day, STATUS_LABEL[d.status], d.awayFrom, d.awayTo]),
    ]);
  return (
    <div className="page">
      <PageHeader
        title="Attendance"
        description="Mark your members for today or past days. A day nobody marked shows as absent but does not change escalation."
        actions={<><Button icon="download" onClick={csv} disabled={!data}>Export CSV</Button><Button variant="primary" icon="calendar" onClick={() => setRange(true)}>Mark a range</Button></>}
      />
      <Tabs label="Attendance view" value={tab} onChange={setTab} tabs={[{ id: 'day', label: 'Day' }, { id: 'month', label: 'Month' }]} />
      <div className="filters">
        {tab === 'day' ? (
          <Input type="date" aria-label="Day" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
        ) : (
          <Input type="month" aria-label="Month" value={day.slice(0, 7)} max={today.slice(0, 7)} onChange={(e) => e.target.value && setDay(e.target.value === today.slice(0, 7) ? today : `${e.target.value}-01`)} />
        )}
        <Select aria-label="Department" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">Any department</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Anyone</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {(['present', 'absent', 'half_day', 'leave', 'unmarked'] as AttendanceStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </Select>
      </div>
      {!data ? (
        <Skeleton rows={8} />
      ) : people.length === 0 ? (
        <Card><Empty icon="users" title="No staff yet">Once staff are added to your vertical, you can mark their attendance here.</Empty></Card>
      ) : tab === 'day' ? (
        <DayView day={day} people={people} dayOf={dayOf} teamOf={(id) => org.data?.teams.find((t) => t.id === String(id))?.name ?? null} pending={mark.pending} onMark={(m) => mark.run(m)} />
      ) : (
        <MonthGrid from={from} to={to} today={today} people={people} dayOf={dayOf} workDaysOf={(entityId) => org.data?.departments.find((d) => d.id === entityId)?.worktime?.workDays ?? [1, 2, 3, 4, 5]} />
      )}
      {range && <RangeDialog people={people} today={today} onClose={() => setRange(false)} />}
    </div>
  );
}

/** One-click marks per person (owner screenshot 2026-11-13); short labels, full words for screen readers. */
const SEGMENTS: { value: string; short: string; tone: string }[] = [
  { value: 'present', short: 'Present', tone: 'ok' },
  { value: 'absent', short: 'Absent', tone: 'danger' },
  { value: 'half-first', short: '½ AM', tone: 'warn' },
  { value: 'half-second', short: '½ PM', tone: 'warn' },
  { value: 'leave', short: 'Leave', tone: 'info' },
];
/** Which button a saved mark is. A half day away from before noon is the morning half (start of work to lunch). */
function markedAs(d: { status: AttendanceStatus; awayFrom: string | null } | undefined): string | null {
  if (!d || d.status === 'unmarked') return null;
  if (d.status === 'half_day') return d.awayFrom && d.awayFrom < '12:00' ? 'half-first' : 'half-second';
  return d.status;
}
const choiceLabel = (v: string) => CHOICES.find((x) => x.value === v)!.label;

function DayView({ day, people, dayOf, teamOf, pending, onMark }: { day: string; people: { id: number; name: string; teamId: number | null }[]; dayOf: (u: number, d: string) => { status: AttendanceStatus; awayFrom: string | null; awayTo: string | null } | undefined; teamOf: (teamId: number | null) => string | null; pending: boolean; onMark: (m: MarkInput) => void }) {
  const statusOf = (id: number) => dayOf(id, day)?.status ?? 'unmarked';
  const unmarked = people.filter((p) => statusOf(p.id) === 'unmarked');
  const counts = (['present', 'half_day', 'leave', 'absent', 'unmarked'] as AttendanceStatus[]).map((st) => [st, people.filter((p) => statusOf(p.id) === st).length] as const).filter(([, n]) => n);
  return (
    <Card>
      <div className="att-panel">
      <div className="att-day-head">
        <div className="att-day-counts" aria-live="polite">
          {counts.map(([st, n]) => (
            <span key={st} className="att-count">
              <i className={`att-sq is-${st}`} /> {n} {st === 'unmarked' ? 'not marked' : STATUS_LABEL[st].toLowerCase()}
            </span>
          ))}
        </div>
        {/* Review I-2: only people nobody marked yet; never overwrite a leave, absence or half day. */}
        {unmarked.length ? (
          <Button size="sm" variant="primary" icon="check" disabled={pending} onClick={() => onMark({ userIds: unmarked.map((p) => p.id), from: day, to: day, status: 'present', onlyUnmarked: true })}>
            Mark the {unmarked.length} unmarked present
          </Button>
        ) : (
          <Tag tone="ok">Everyone is marked</Tag>
        )}
      </div>
      <ul className="att-day-list">
        {people.map((p) => {
          const d = dayOf(p.id, day);
          const current = markedAs(d);
          return (
            <li key={p.id} className="att-day-row">
              <div className="att-day-who">
                <Avatar name={p.name} size={32} />
                <div>
                  <strong>{p.name}</strong>
                  <span className="muted small">{teamOf(p.teamId) ?? 'No department'}</span>
                </div>
              </div>
              <div className="att-day-status">
                <StatusTag status={d?.status ?? 'unmarked'} />
                {d?.status === 'half_day' && <span className="muted small">away {d.awayFrom}–{d.awayTo}</span>}
              </div>
              <div className="att-seg" role="group" aria-label={`Mark ${p.name}`}>
                {SEGMENTS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    className={`att-seg-btn tone-${c.tone}`}
                    aria-pressed={current === c.value}
                    aria-label={choiceLabel(c.value)}
                    title={choiceLabel(c.value)}
                    disabled={pending}
                    onClick={() => current !== c.value && onMark({ userIds: [p.id], from: day, to: day, ...choice(c.value) })}
                  >
                    {c.short}
                  </button>
                ))}
                {/* An empty placeholder keeps every row's buttons aligned. */}
                {!current && <span className="att-seg-clear" aria-hidden="true" />}
                {current && (
                  <button type="button" className="att-seg-clear" aria-label={`Clear the mark for ${p.name}`} title="Clear" disabled={pending} onClick={() => onMark({ userIds: [p.id], from: day, to: day, status: 'unmarked' })}>
                    ×
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      </div>
    </Card>
  );
}

/** A month heatmap: one square per person per day (owner, 2026-11-13). Future days empty; non-working days greyed. */
function MonthGrid({ from, to, today, people, dayOf, workDaysOf }: { from: string; to: string; today: string; people: { id: number; name: string; entityId: string }[]; dayOf: (u: number, d: string) => { status: AttendanceStatus; awayFrom?: string | null; awayTo?: string | null } | undefined; workDaysOf: (entityId: string) => readonly number[] }) {
  const days = useMemo(() => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  }, [from, to]);
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const COUNTED: AttendanceStatus[] = ['present', 'half_day', 'leave', 'absent'];
  const short: Record<AttendanceStatus, string> = { present: 'P', half_day: '½', leave: 'L', absent: 'A', unmarked: 'A' };
  return (
    <Card>
      <div className="att-panel">
      <div className="table-scroll">
        <div className="att-hm" style={{ gridTemplateColumns: `minmax(120px, 180px) repeat(${days.length}, minmax(18px, 1fr)) auto` }} role="table" aria-label="Attendance this month">
          <div className="att-hm-head" role="columnheader">Person</div>
          {days.map((d) => (
            <div key={d} role="columnheader" className={`att-hm-day${d === today ? ' is-today' : ''}`}>
              <span>{WD[dow(d)]}</span>
              <strong>{+d.slice(8)}</strong>
            </div>
          ))}
          <div className="att-hm-head" role="columnheader">This month</div>
          {people.map((p) => {
            const work = workDaysOf(p.entityId);
            const counts = Object.fromEntries(COUNTED.map((c) => [c, 0])) as Record<AttendanceStatus, number>;
            return [
              <div key={`n${p.id}`} className="att-hm-name" role="rowheader">{p.name}</div>,
              ...days.map((d) => {
                const mark = dayOf(p.id, d);
                const s = mark?.status ?? 'unmarked';
                const future = d > today;
                const off = s === 'unmarked' && !work.includes(dow(d));
                if (!future && !off) counts[s === 'unmarked' ? 'absent' : s]++;
                const cls = future ? 'is-future' : off ? 'is-off' : `is-${s}`;
                const label = future ? 'Not yet' : off ? 'Not a working day' : s === 'unmarked' ? 'Absent (not marked)' : s === 'half_day' ? `Half day, away ${mark?.awayFrom}–${mark?.awayTo}` : STATUS_LABEL[s];
                return <span key={d} role="cell" className={`att-sq ${cls}`} title={`${p.name} · ${d}: ${label}`} aria-label={`${d}: ${label}`} />;
              }),
              <div key={`s${p.id}`} className="att-hm-sum" role="cell">
                {COUNTED.filter((c) => counts[c]).map((c) => <span key={c} className={`att-sum-${c}`}>{counts[c]} {short[c]}</span>)}
              </div>,
            ];
          })}
        </div>
      </div>
      <div className="att-hm-legend muted small">
        <span><i className="att-sq is-present" /> Present</span>
        <span><i className="att-sq is-half_day" /> Half day</span>
        <span><i className="att-sq is-leave" /> Leave</span>
        <span><i className="att-sq is-absent" /> Absent</span>
        <span><i className="att-sq is-unmarked" /> Not marked (counts as absent)</span>
        <span><i className="att-sq is-off" /> Not a working day</span>
      </div>
      </div>
    </Card>
  );
}

function RangeDialog({ people, today, onClose }: { people: { id: number; name: string }[]; today: string; onClose: () => void }) {
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [pick, setPick] = useState('leave');
  const save = useAction(markAttendance, { success: (r) => `${r.updated} day${r.updated === 1 ? '' : 's'} marked.`, onSuccess: onClose });
  const f = save.fields;
  return (
    <Dialog open onClose={onClose} title="Mark a range" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.pending} onClick={() => save.run({ userIds: userId ? [Number(userId)] : [], from, to, ...choice(pick) })}>Mark</Button></>}>
      <div className="stack">
        <Field label="Person" htmlFor="att-p" required error={f.userIds}>
          <Select id="att-p" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <div className="grid-2">
          <Field label="From" htmlFor="att-from" error={f.from}><Input id="att-from" type="date" max={today} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To" htmlFor="att-to" error={f.to ?? f.day}><Input id="att-to" type="date" max={today} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Field label="Status" htmlFor="att-s" error={f.half}>
          <Select id="att-s" value={pick} onChange={(e) => setPick(e.target.value)}>
            {CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </Select>
        </Field>
        <Banner tone="info">Today and past days only. A range covers the person's working days. A half day is split at lunch, the middle of the vertical's working hours.</Banner>
      </div>
    </Dialog>
  );
}

/** Everyone with attendance: their own month, read-only. */
export function MyAttendancePage() {
  const auth = useAuth();
  const today = todayIn(auth.bootstrap?.user.timezone ?? 'UTC');
  const [month, setMonth] = useState(today.slice(0, 7));
  const q = useApi(['my-attendance', month], () => myAttendance(month));
  if (q.error) return <ErrorState error={q.error} />;
  const first = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  return (
    <div className="page">
      <PageHeader title="My attendance" description="As your general manager marked it. Days nobody marked show as absent." actions={<Input type="month" aria-label="Month" value={month} max={today.slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />} />
      {!q.data ? (
        <Skeleton rows={6} />
      ) : (
        <Card>
          <div className="att-cal">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="att-cal-head">{d}</div>)}
            {Array.from({ length: first }, (_, i) => <div key={`pad${i}`} />)}
            {q.data.days.map((d) => (
              <div key={d.day} className={`att-cal-day${d.day > today ? ' is-future' : ''}`}>
                <span className="att-cal-num">{+d.day.slice(8)}</span>
                {d.day <= today && <StatusTag status={d.status} />}
                {d.status === 'half_day' && <span className="muted small">{d.awayFrom}–{d.awayTo}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
