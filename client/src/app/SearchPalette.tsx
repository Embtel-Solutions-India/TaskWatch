import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROLE_LABEL } from '../constants';
import { Icon } from '../components/icons';
import { Avatar, Dialog, LevelBadge, StatusBadge } from '../components/ui';
import { useLocalState, useMe } from '../hooks';
import { search } from '../services/api/misc';
import { hasPerm } from '../services/authz/permissions';
import { getDb } from '../services/mock/store';
import { cx } from '../utils/format';

interface Item {
  key: string;
  group: 'Tasks' | 'People' | 'Teams' | 'Recent';
  label: string;
  sub: string;
  go: () => void;
  render?: React.ReactNode;
}

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const user = useMe();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useLocalState<string[]>(`recent-search.${user.id}`, []);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    if (!q.trim())
      return recent.map((r) => ({ key: `r-${r}`, group: 'Recent' as const, label: r, sub: 'Recent search', go: () => setQ(r) }));
    const res = search(q); // permission-aware in the service
    const db = getDb();
    const canStaff = hasPerm(db, user, 'manage_staff');
    const close = (to: string) => () => {
      setRecent([q.trim(), ...recent.filter((x) => x !== q.trim())].slice(0, 6));
      onClose();
      nav(to);
    };
    return [
      ...res.tasks.map((t) => ({
        key: t.id,
        group: 'Tasks' as const,
        label: `${t.id} · ${t.title}`,
        sub: `${t.assignee?.name ?? ''} · from ${t.giver?.name ?? ''}${t.team ? ` · ${t.team.name}` : ''}`,
        go: close(`/tasks/${t.id}`),
        render: (
          <span className="search-badges">
            <StatusBadge status={t.status} />
            {t.level >= 0 && <LevelBadge level={t.level} />}
          </span>
        ),
      })),
      ...res.people.map((p) => ({
        key: p.id,
        group: 'People' as const,
        label: p.name,
        sub: `${p.title} · ${ROLE_LABEL[p.role]}`,
        go: close(canStaff ? `/admin/staff/${p.id}` : p.id === user.id ? '/profile' : `/admin/staff/${p.id}`),
        render: <Avatar name={p.name} size={22} />,
      })),
      ...res.teams.map((t) => ({ key: t.id, group: 'Teams' as const, label: t.name, sub: 'Team · open team tasks', go: close(`/tasks/team?team=${t.id}`) })),
    ];
  }, [q, open, recent, user, nav, onClose, setRecent]);

  useEffect(() => setActive(0), [q]);

  const groups = ['Recent', 'Tasks', 'People', 'Teams'] as const;
  return (
    <Dialog open={open} onClose={onClose} title="Search" description="Results only include records you are allowed to see.">
      <div className="search-box">
        <Icon name="search" size={16} />
        <input
          autoFocus
          className="search-input"
          placeholder="Task ID, title, person, team…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls="search-results"
          aria-activedescendant={items[active] ? `sr-${items[active]!.key}` : undefined}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => Math.min(items.length - 1, a + 1)));
            if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
            if (e.key === 'Enter' && items[active]) (e.preventDefault(), items[active]!.go());
          }}
        />
      </div>
      <div id="search-results" role="listbox" aria-label="Search results" className="search-results">
        {q.trim() && items.length === 0 && <p className="muted pad">No results you have access to for "{q}".</p>}
        {!q.trim() && items.length === 0 && <p className="muted pad">Try a task ID like TW-1012, a person's name, or a team.</p>}
        {groups.map((g) => {
          const list = items.filter((i) => i.group === g);
          if (!list.length) return null;
          return (
            <div key={g} role="group" aria-label={g}>
              <div className="search-group">{g}</div>
              {list.map((i) => {
                const idx = items.indexOf(i);
                return (
                  <div key={i.key} id={`sr-${i.key}`} role="option" aria-selected={idx === active} className={cx('search-item', idx === active && 'active')} onMouseEnter={() => setActive(idx)} onClick={i.go}>
                    {i.render && g === 'People' ? i.render : <Icon name={g === 'Tasks' ? 'check-square' : g === 'Teams' ? 'users' : 'clock'} size={15} />}
                    <span className="search-item-text">
                      <strong>{i.label}</strong>
                      <small>{i.sub}</small>
                    </span>
                    {g === 'Tasks' && i.render}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </Dialog>
  );
}
