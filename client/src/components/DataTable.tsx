import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocalState } from '../hooks';
import { cx } from '../utils/format';
import { Icon } from './icons';
import { Checkbox, Empty, IconButton, Pagination, Popover, Skeleton } from './ui';

export interface Column<T> {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  sort?: (row: T) => string | number;
  align?: 'right';
  width?: string;
  /** Hidden by default; the user can show it from the Columns menu. */
  defaultHidden?: boolean;
  /** Cannot be hidden. */
  fixed?: boolean;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  selectable,
  bulkBar,
  initialSort,
  storageKey,
  empty,
  loading,
  toolbar,
  pageSize: initialPageSize = 25,
  caption,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  onRowClick?: (r: T) => void;
  selectable?: boolean;
  bulkBar?: (selected: string[], clear: () => void) => ReactNode;
  initialSort?: { id: string; dir: 'asc' | 'desc' };
  storageKey: string;
  empty?: ReactNode;
  loading?: boolean;
  toolbar?: ReactNode;
  pageSize?: number;
  caption: string;
}) {
  const [hidden, setHidden] = useLocalState<string[]>(`cols.${storageKey}`, columns.filter((c) => c.defaultHidden).map((c) => c.id));
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useLocalState(`pagesize.${storageKey}`, initialPageSize);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visible = columns.filter((c) => c.fixed || !hidden.includes(c.id));
  const sorted = useMemo(() => {
    const col = columns.find((c) => c.id === sort?.id);
    if (!col?.sort || !sort) return rows;
    const f = col.sort;
    return [...rows].sort((a, b) => {
      const x = f(a);
      const y = f(b);
      const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, sort, columns]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => {
    if (page > pages - 1) setPage(0);
  }, [pages, page]);
  // Drop selections that are no longer in the result set (e.g. after filtering).
  useEffect(() => {
    const keys = new Set(rows.map(rowKey));
    setSelected((s) => {
      const next = new Set([...s].filter((k) => keys.has(k)));
      return next.size === s.size ? s : next;
    });
  }, [rows, rowKey]);

  const pageRows = sorted.slice(page * pageSize, (page + 1) * pageSize);
  const pageKeys = pageRows.map(rowKey);
  const allOnPage = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));

  const toggleSort = (c: Column<T>) => {
    if (!c.sort) return;
    setSort((s) => (s?.id === c.id ? (s.dir === 'asc' ? { id: c.id, dir: 'desc' } : null) : { id: c.id, dir: 'asc' }));
  };

  return (
    <div className="table-card">
      <div className="table-toolbar">
        <div className="table-toolbar-main">{toolbar}</div>
        <Popover trigger={({ toggle, open, id }) => <IconButton icon="columns" label="Show or hide columns" aria-expanded={open} aria-controls={id} onClick={toggle} />}>
          <div className="menu col-menu">
            <div className="menu-title">Columns</div>
            {columns
              .filter((c) => !c.fixed)
              .map((c) => (
                <Checkbox key={c.id} label={c.header} checked={!hidden.includes(c.id)} onChange={(e) => setHidden(e.target.checked ? hidden.filter((h) => h !== c.id) : [...hidden, c.id])} />
              ))}
          </div>
        </Popover>
      </div>
      {selectable && selected.size > 0 && bulkBar && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <strong>{selected.size} selected</strong>
          {bulkBar([...selected], () => setSelected(new Set()))}
          <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      <div className="table-scroll">
        <table className="table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {selectable && (
                <th className="col-check">
                  <input
                    type="checkbox"
                    aria-label="Select all rows on this page"
                    checked={allOnPage}
                    onChange={() => {
                      const s = new Set(selected);
                      pageKeys.forEach((k) => (allOnPage ? s.delete(k) : s.add(k)));
                      setSelected(s);
                    }}
                  />
                </th>
              )}
              {visible.map((c) => (
                <th key={c.id} style={{ width: c.width }} className={cx(c.align === 'right' && 'right')} aria-sort={sort?.id === c.id ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {c.sort ? (
                    <button type="button" className="th-sort" onClick={() => toggleSort(c)}>
                      {c.header}
                      <Icon name={sort?.id === c.id ? (sort.dir === 'asc' ? 'arrow-up' : 'arrow-down') : 'sort'} size={12} className={sort?.id === c.id ? '' : 'faint'} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={visible.length + (selectable ? 1 : 0)}>
                  <Skeleton rows={6} />
                </td>
              </tr>
            ) : pageRows.length === 0 ? (
              <tr>
                <td colSpan={visible.length + (selectable ? 1 : 0)} className="td-empty">
                  {empty ?? <Empty title="Nothing to show" />}
                </td>
              </tr>
            ) : (
              pageRows.map((r) => {
                const k = rowKey(r);
                return (
                  <tr key={k} className={cx(onRowClick && 'clickable', selected.has(k) && 'selected')} onClick={onRowClick ? (e) => !(e.target as HTMLElement).closest('a,button,input,label') && onRowClick(r) : undefined}>
                    {selectable && (
                      <td className="col-check">
                        <input
                          type="checkbox"
                          aria-label={`Select ${k}`}
                          checked={selected.has(k)}
                          onChange={() => {
                            const s = new Set(selected);
                            s.has(k) ? s.delete(k) : s.add(k);
                            setSelected(s);
                          }}
                        />
                      </td>
                    )}
                    {visible.map((c) => (
                      <td key={c.id} data-label={c.header} className={cx(c.align === 'right' && 'right')}>
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={page} pages={pages} onPage={setPage} total={sorted.length} pageSize={pageSize} onPageSize={(n) => (setPageSize(n), setPage(0))} />
    </div>
  );
}
