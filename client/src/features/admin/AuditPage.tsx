import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DataTable } from '../../components/DataTable';
import { Banner, Button, ErrorState, Input, PageHeader, Select, Tag } from '../../components/ui';
import { useAction, useApi } from '../../hooks';
import { checkAuditChain, listAudit } from '../../services/api/admin';
import { getDb } from '../../services/mock/store';
import { BACKEND } from '../../services/http';
import type { AuditRecord } from '../../types';
import { downloadCsv, formatDateTime } from '../../utils/format';

export function AuditPage() {
  const q = useApi(['audit'], listAudit);
  const check = useAction(checkAuditChain, { success: (r) => (r.ok ? 'Integrity check passed: no log row was changed or removed.' : `Integrity check found ${r.breaks.length} problem(s). The Chief of Staff has been alerted.`) });
  const db = getDb();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [task, setTask] = useState('');
  const [team, setTeam] = useState('');
  const [source, setSource] = useState('');
  const rows = q.data ?? [];
  const actions = [...new Set(rows.map((r) => r.action.split('.')[0]!))].sort();
  // Server mode: each row carries its actor's name; the prototype looks people up in its store.
  const serverNames = new Map(rows.map((r) => [r.actorId, (r as { actorName?: string | null }).actorName ?? null]));
  const name = (id: string | null) => (!id ? 'System' : BACKEND === 'server' ? (serverNames.get(id) ?? id) : (db.users.find((u) => u.id === id)?.name ?? id));
  const people = BACKEND === 'server' ? [...serverNames].filter(([id]) => id).map(([id, n]) => ({ id: id!, name: n ?? id! })) : db.users;
  const filtered = useMemo(
    () =>
      rows.filter((r) => {
        if (from && r.at.slice(0, 10) < from) return false;
        if (to && r.at.slice(0, 10) > to) return false;
        if (actor && (actor === 'system' ? r.actorId !== null : r.actorId !== actor)) return false;
        if (action && !r.action.startsWith(action + '.')) return false;
        if (task && !(r.taskId ?? '').toLowerCase().includes(task.toLowerCase())) return false;
        if (source && r.source !== source) return false;
        if (team && BACKEND === 'mock') {
          const t = r.taskId ? db.tasks.find((x) => x.id === r.taskId) : null;
          const u = r.targetType === 'user' ? db.users.find((x) => x.id === r.targetId) : null;
          if ((t?.teamId ?? u?.teamId) !== team) return false;
        }
        return true;
      }),
    [rows, from, to, actor, action, task, team, source, db],
  );
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <div className="page">
      <PageHeader
        title="Audit Logs"
        description="Every change made through TaskWatch, with who made it, what changed and why."
        actions={
          <>
          {BACKEND === 'server' && (
            <Button icon="shield" loading={check.pending} onClick={() => check.run()}>
              Check integrity now
            </Button>
          )}
          <Button icon="download" disabled={!filtered.length} onClick={() => downloadCsv('taskwatch-audit.csv', [['Timestamp', 'Actor', 'Action', 'Target type', 'Target', 'Task ID', 'Previous', 'New', 'Source', 'Context'], ...filtered.map((r) => [r.at, name(r.actorId), r.action, r.targetType, r.targetId, r.taskId, r.prev, r.next, r.source, r.context])])}>
            Export CSV
          </Button>
          </>
        }
      />
      <Banner tone="info" icon="shield">
        Retention policy: audit records are retained for <strong>{BACKEND === 'server' ? 7 : db.settings.retentionYears} years</strong>.{' '}
        {BACKEND === 'server' ? 'Rows are append-only on the server and hash-chained; no one can edit or delete them.' : 'In this prototype they are stored in the browser and can be reset with demo data; production-grade immutable retention requires backend support.'}
      </Banner>
      <DataTable<AuditRecord>
        caption="Audit log"
        storageKey="audit"
        rows={filtered}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        initialSort={{ id: 'at', dir: 'desc' }}
        pageSize={50}
        toolbar={
          <div className="filters">
            <label className="inline-field">
              From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-sm" />
            </label>
            <label className="inline-field">
              To <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-sm" />
            </label>
            <Select aria-label="User" value={actor} onChange={(e) => setActor(e.target.value)}>
              <option value="">Any user</option>
              <option value="system">System</option>
              {people.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Action type" value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">Any action</option>
              {actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
            {BACKEND === 'mock' && <Select aria-label="Team" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">Any team</option>
              {db.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>}
            <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Any source</option>
              <option value="ui">User action</option>
              <option value="system">System</option>
              <option value="demo">Demo mode</option>
            </Select>
            <div className="filter-search">
              <Input aria-label="Task ID" placeholder="Task ID" value={task} onChange={(e) => setTask(e.target.value)} />
            </div>
          </div>
        }
        columns={[
          { id: 'at', header: 'Timestamp', width: '170px', cell: (r) => <span className="nowrap">{formatDateTime(r.at)}</span>, sort: (r) => r.at },
          { id: 'actor', header: 'Actor', cell: (r) => name(r.actorId), sort: (r) => name(r.actorId) },
          { id: 'action', header: 'Action', cell: (r) => <code className="code">{r.action}</code>, sort: (r) => r.action },
          { id: 'target', header: 'Target', cell: (r) => <span>{r.targetType} · {r.targetType === 'user' ? name(r.targetId) : r.targetId}</span>, sort: (r) => r.targetId },
          { id: 'task', header: 'Task ID', cell: (r) => (r.taskId ? <Link to={`/tasks/${r.taskId}`} className="mono">{r.taskId}</Link> : '—'), sort: (r) => r.taskId ?? '' },
          { id: 'prev', header: 'Previous value', cell: (r) => r.prev ?? <span className="muted">—</span> },
          { id: 'next', header: 'New value', cell: (r) => r.next ?? <span className="muted">—</span> },
          { id: 'source', header: 'Source', cell: (r) => <Tag tone={r.source === 'system' ? 'info' : r.source === 'demo' ? 'warn' : undefined}>{r.source}</Tag>, sort: (r) => r.source },
          { id: 'context', header: 'Context', defaultHidden: true, cell: (r) => r.context || '—' },
        ]}
      />
    </div>
  );
}
