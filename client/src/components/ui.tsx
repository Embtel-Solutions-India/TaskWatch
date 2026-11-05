import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { LEVEL_LABEL, LEVEL_SHORT, PRIORITY_LABEL, ROLE_LABEL, STATUS_LABEL } from '../constants';
import type { Priority, Role, Status } from '../types';
import { bytes, cx, initials } from '../utils/format';
import { Icon, type IconName } from './icons';

/* ---------------- Buttons ---------------- */

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
export function Button({ variant = 'secondary', size, icon, iconRight, loading, children, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'lg'; icon?: IconName; iconRight?: IconName; loading?: boolean }) {
  return (
    <button type="button" className={cx('btn', `btn-${variant}`, size && `btn-${size}`, className)} disabled={loading || rest.disabled} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={14} />}
    </button>
  );
}

export function IconButton({ icon, label, className, badge, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; badge?: number }) {
  return (
    <button type="button" className={cx('icon-btn', className)} aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={17} />
      {badge ? <span className="icon-badge">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );
}

/* ---------------- Badges ---------------- */

const STATUS_ICON: Record<Status, IconName> = {
  draft: 'circle-dash',
  assigned: 'circle',
  in_progress: 'circle-half',
  blocked: 'alert',
  submitted: 'review',
  changes_requested: 'rotate',
  reopened: 'rotate',
  completed: 'circle-check',
  cancelled: 'circle-x',
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={cx('badge', `st-${status}`)}>
      <Icon name={STATUS_ICON[status]} size={13} />
      {STATUS_LABEL[status]}
    </span>
  );
}

const PRIORITY_BARS: Record<Priority, number> = { critical: 4, high: 3, normal: 2, low: 1 };
export function PriorityBadge({ priority, compact }: { priority: Priority; compact?: boolean }) {
  return (
    <span className={cx('prio', `pr-${priority}`)} title={`${PRIORITY_LABEL[priority]} priority`}>
      <span className="prio-bars" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <i key={i} className={i <= PRIORITY_BARS[priority] ? 'on' : ''} />
        ))}
      </span>
      {!compact && PRIORITY_LABEL[priority]}
      {compact && <span className="sr-only">{PRIORITY_LABEL[priority]}</span>}
    </span>
  );
}

export function LevelBadge({ level, acked, long }: { level: number; acked?: boolean; long?: boolean }) {
  if (level < 0) return <span className="lvl lvl-ok">On track</span>;
  return (
    <span className={cx('lvl', `lvl-${level}`, acked && 'lvl-acked')} title={`${LEVEL_LABEL[level]}${acked ? ' · acknowledged' : ''}`}>
      <Icon name={level >= 2 ? 'alert' : 'clock'} size={12} />
      {long ? LEVEL_LABEL[level] : LEVEL_SHORT[level]}
      {acked && <Icon name="check" size={11} />}
    </span>
  );
}

export function RoleBadge({ role }: { role: Role }) {
  return <span className={cx('tag', `role-${role}`)}>{ROLE_LABEL[role]}</span>;
}

export function Tag({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'muted' }) {
  return <span className={cx('tag', tone && `tag-${tone}`)}>{children}</span>;
}

export function Avatar({ name, size = 24, inactive }: { name: string; size?: number; inactive?: boolean }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span className={cx('avatar', inactive && 'avatar-off')} style={{ width: size, height: size, fontSize: size * 0.4, ['--hue' as string]: h }} aria-hidden>
      {initials(name)}
    </span>
  );
}

export function PersonLink({ id, name, avatar = true }: { id: string; name: string; avatar?: boolean }) {
  return (
    <span className="person">
      {avatar && <Avatar name={name} size={20} />}
      <span>{name}</span>
      <span className="sr-only">({id})</span>
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  return (
    <span className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? 'Progress'}>
      <span style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </span>
  );
}

/* ---------------- Layout ---------------- */

export function Card({ title, actions, children, className, pad = true, sub }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; sub?: ReactNode }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {sub && <p className="card-sub">{sub}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'card-body' : undefined}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {meta}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone, to, help }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'danger' | 'warn' | 'ok'; to?: string; help?: string }) {
  const body = (
    <>
      <span className="stat-label">
        {label}
        {help && <InfoTip text={help} />}
      </span>
      <span className={cx('stat-value', tone && `tone-${tone}`)}>{value}</span>
      {hint && <span className="stat-hint">{hint}</span>}
    </>
  );
  return to ? (
    <Link to={to} className="stat stat-link">
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function InfoTip({ text }: { text: string }) {
  const id = useId();
  return (
    <span className="tip">
      <button type="button" className="tip-btn" aria-describedby={id} aria-label="More information">
        <Icon name="info" size={13} />
      </button>
      <span role="tooltip" id={id} className="tip-body">
        {text}
      </span>
    </span>
  );
}

/* ---------------- Feedback ---------------- */

export function Skeleton({ rows = 4, height = 14 }: { rows?: number; height?: number }) {
  return (
    <div className="skeleton-wrap" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton" style={{ height, width: `${70 + ((i * 37) % 30)}%` }} />
      ))}
    </div>
  );
}

export function Empty({ icon = 'inbox', title, children, action }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as { status?: number; message?: string };
  if (e?.status === 403) return <AccessDenied message={e.message} />;
  if (e?.status === 404)
    return (
      <Empty icon="search" title="Not found" action={<Link className="btn btn-secondary" to="/">Back to overview</Link>}>
        {e.message}
      </Empty>
    );
  return (
    <div className="empty" role="alert">
      <span className="empty-icon tone-danger">
        <Icon name="alert" size={22} />
      </span>
      <h3>Something went wrong</h3>
      <p>{e?.message ?? 'Unexpected error.'}</p>
      {onRetry && <Button onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function AccessDenied({ message }: { message?: string }) {
  return (
    <div className="empty denied" role="alert">
      <span className="empty-icon tone-danger">
        <Icon name="lock" size={22} />
      </span>
      <h3>Access denied</h3>
      <p>{message ?? "You don't have permission to view this page."} If you think you should, contact your Chief of Staff.</p>
      <Link className="btn btn-secondary" to="/">
        Back to overview
      </Link>
    </div>
  );
}

export function Banner({ tone = 'info', icon, children, action }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; icon?: IconName; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx('banner', `banner-${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon ?? (tone === 'ok' ? 'circle-check' : tone === 'info' ? 'info' : 'alert')} size={16} />
      <div className="banner-text">{children}</div>
      {action}
    </div>
  );
}

/* ---------------- Forms ---------------- */

export function Field({ label, hint, error, children, required, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; required?: boolean; htmlFor?: string }) {
  return (
    <div className={cx('field', error && 'field-error')}>
      <label htmlFor={htmlFor}>
        {label}
        {required && <span className="req" aria-hidden> *</span>}
      </label>
      {children}
      {error ? (
        <span className="field-msg" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <input className={cx('input', className)} aria-invalid={invalid || undefined} {...rest} />;
}
export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <select className={cx('input select', className)} aria-invalid={invalid || undefined} {...rest} />;
}
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  const { invalid, className, ...rest } = props;
  return <textarea className={cx('input textarea', className)} aria-invalid={invalid || undefined} {...rest} />;
}
export function Checkbox({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" {...rest} />
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

export function FilePicker({ files, onChange, label = 'Attach files' }: { files: File[]; onChange: (f: File[]) => void; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="filepick">
      <input ref={ref} type="file" multiple hidden onChange={(e) => onChange([...files, ...Array.from(e.target.files ?? [])])} />
      <Button size="sm" icon="clip" onClick={() => ref.current?.click()}>
        {label}
      </Button>
      {files.length > 0 && (
        <ul className="filepick-list">
          {files.map((f, i) => (
            <li key={i}>
              <Icon name="file" size={13} /> {f.name} <span className="muted">{bytes(f.size)}</span>
              <button type="button" className="link-btn" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))}>
                <Icon name="x" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="field-hint">Files stay in this browser tab only. Nothing is uploaded in the prototype.</span>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number }[]; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------- Tabs ---------------- */

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          role="tab"
          type="button"
          id={`tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`panel-${t.id}`}
          tabIndex={value === t.id ? 0 : -1}
          className={value === t.id ? 'on' : ''}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            const n = (i + d + tabs.length) % tabs.length;
            onChange(tabs[n]!.id);
            refs.current[n]?.focus();
          }}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className="count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} className="tab-panel">
      {children}
    </div>
  );
}

/* ---------------- Dialog & Drawer (native <dialog>: focus trap + Esc for free) ---------------- */

export function Dialog({ open, onClose, title, description, children, footer, size, drawer }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'lg'; drawer?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={cx('dialog', size && `dialog-${size}`, drawer && 'drawer')}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <header className="dialog-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; children: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/* ---------------- Popover / menu ---------------- */

export function Popover({ trigger, children, align = 'end', className, open: controlled, onOpenChange }: { trigger: (p: { open: boolean; toggle: () => void; id: string }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: 'start' | 'end'; className?: string; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const [inner, setInner] = useState(false);
  const open = controlled ?? inner;
  const setOpen = useCallback((o: boolean) => (onOpenChange ? onOpenChange(o) : setInner(o)), [onOpenChange]);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);
  const close = () => setOpen(false);
  return (
    <div className="popover-wrap" ref={ref}>
      {trigger({ open, toggle: () => setOpen(!open), id })}
      {open && (
        <div id={id} className={cx('popover', `popover-${align}`, className)}>
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function Menu({ label, icon = 'more', items, buttonLabel }: { label: string; icon?: IconName; buttonLabel?: ReactNode; items: ({ label: string; icon?: IconName; onClick: () => void; danger?: boolean; disabled?: boolean } | null)[] }) {
  const list = items.filter(Boolean) as NonNullable<(typeof items)[number]>[];
  if (!list.length) return null;
  return (
    <Popover
      trigger={({ open, toggle, id }) =>
        buttonLabel ? (
          <Button icon={icon} iconRight="chevron-down" aria-expanded={open} aria-controls={id} aria-haspopup="menu" onClick={toggle}>
            {buttonLabel}
          </Button>
        ) : (
          <IconButton icon={icon} label={label} aria-expanded={open} aria-controls={id} aria-haspopup="menu" onClick={toggle} />
        )
      }
    >
      {(close) => (
        <div role="menu" className="menu" aria-label={label}>
          {list.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              type="button"
              disabled={it.disabled}
              className={cx('menu-item', it.danger && 'danger')}
              onClick={() => {
                close();
                it.onClick();
              }}
            >
              {it.icon && <Icon name={it.icon} size={14} />}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

/* ---------------- Pagination ---------------- */

export function Pagination({ page, pages, onPage, total, pageSize, onPageSize }: { page: number; pages: number; onPage: (p: number) => void; total: number; pageSize: number; onPageSize?: (n: number) => void }) {
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="muted">
        {from}–{to} of {total}
      </span>
      {onPageSize && (
        <label className="muted pagesize">
          Rows
          <select className="input select input-sm" value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {[10, 25, 50, 100].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
      )}
      <IconButton icon="chevron-left" label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)} />
      <span className="muted">
        Page {pages === 0 ? 0 : page + 1} of {pages}
      </span>
      <IconButton icon="chevron-right" label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} />
    </nav>
  );
}

/* ---------------- Toasts ---------------- */

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  text: string;
}
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.tone === 'error' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.tone}`)} role={t.tone === 'error' ? 'alert' : 'status'}>
            <Icon name={t.tone === 'success' ? 'circle-check' : t.tone === 'error' ? 'alert' : 'info'} size={16} />
            <span>{t.text}</span>
            <button type="button" className="link-btn" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <Icon name="x" size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
