import { useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROLE_LABEL } from '../../constants';
import { Icon } from '../../components/icons';
import { Button, ConfirmDialog, Dialog, useToast } from '../../components/ui';
import { useAuth, useLocalState } from '../../hooks';
import { advanceClock, clockOffsetHours, resetClock, resetDemoData, runScenario, SCENARIOS } from '../../services/api/demo';
import { expireSession, switchUser } from '../../services/api/misc';
import { getDb, getRev, now, subscribe } from '../../services/mock/store';
import { ROLES } from '../../types';
import { formatDateTime, hoursLabel } from '../../utils/format';

export function DemoBar() {
  useSyncExternalStore(subscribe, getRev);
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [active, setActive] = useLocalState<string | null>('scenario', null);
  const [stepsOpen, setStepsOpen] = useLocalState('scenario.open', true);
  const db = getDb();
  const offset = clockOffsetHours();
  const scenario = SCENARIOS.find((s) => s.id === active);

  return (
    <>
      <div className="demobar" role="region" aria-label="Demo mode controls (prototype only)">
        <span className="demobar-tag">
          <Icon name="zap" size={13} /> Demo mode
          <span className="demobar-note">Prototype only, not a production feature</span>
        </span>
        <label className="demobar-field">
          <span>Act as</span>
          <select
            value={user.id}
            onChange={(e) => {
              switchUser(e.target.value);
              refresh();
              toast({ tone: 'info', text: `Now acting as ${db.users.find((u) => u.id === e.target.value)?.name}` });
            }}
          >
            {ROLES.map((r) => (
              <optgroup key={r} label={ROLE_LABEL[r]}>
                {db.users
                  .filter((u) => u.role === r && u.status === 'active')
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} — {u.title}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <span className="demobar-clock" title="Simulated clock used by the escalation engine">
          <Icon name="clock" size={13} /> {formatDateTime(new Date(now()).toISOString())}
          {offset > 0 && <strong> (+{hoursLabel(offset)})</strong>}
        </span>
        <span className="demobar-group" role="group" aria-label="Advance simulated time">
          {[1, 4, 12, 24].map((h) => (
            <button key={h} type="button" onClick={() => (advanceClock(h), toast({ tone: 'info', text: `Clock advanced ${h} h; escalation engine ran.` }))}>
              +{h}h
            </button>
          ))}
          <button type="button" disabled={offset === 0} onClick={() => resetClock()}>
            Now
          </button>
        </span>
        <span className="demobar-spacer" />
        <button type="button" className="demobar-btn" onClick={() => setOpen(true)}>
          <Icon name="play" size={12} /> Scenarios
        </button>
        <button type="button" className="demobar-btn" onClick={() => (expireSession(), refresh())} title="Simulate an expired session">
          Expire session
        </button>
        <button type="button" className="demobar-btn" onClick={() => setConfirmReset(true)}>
          <Icon name="refresh" size={12} /> Reset data
        </button>
      </div>

      {scenario && (
        <aside className="scenario-card" aria-label="Active demo scenario">
          <div className="scenario-card-head">
            <button type="button" className="link-btn" onClick={() => setStepsOpen(!stepsOpen)} aria-expanded={stepsOpen}>
              <Icon name={stepsOpen ? 'chevron-down' : 'chevron-up'} size={14} />
              <strong>Scenario {scenario.id.slice(1)}:</strong> {scenario.title}
            </button>
            <button type="button" className="link-btn" aria-label="Close scenario" onClick={() => setActive(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          {stepsOpen && (
            <ol>
              {scenario.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
        </aside>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title="Demo scenarios" description="Each scenario creates the data it needs, switches to the right user and opens the screen to try. Simulated, browser-only." drawer>
        <ol className="scenario-list">
          {SCENARIOS.map((s, i) => (
            <li key={s.id}>
              <div>
                <strong>
                  {i + 1}. {s.title}
                </strong>
                <small className="muted">Acts as {db.users.find((u) => u.id === s.actAs)?.name} ({ROLE_LABEL[db.users.find((u) => u.id === s.actAs)?.role ?? 'staff']})</small>
              </div>
              <Button
                size="sm"
                icon="play"
                onClick={() => {
                  const { path } = runScenario(s.id);
                  setActive(s.id);
                  setStepsOpen(true);
                  setOpen(false);
                  refresh();
                  nav(path);
                }}
              >
                Run
              </Button>
            </li>
          ))}
        </ol>
      </Dialog>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        danger
        title="Reset demo data?"
        confirmLabel="Reset data"
        onConfirm={() => {
          resetDemoData();
          setActive(null);
          setConfirmReset(false);
          refresh();
          nav('/');
          toast({ tone: 'success', text: 'Demo data restored to the original seed.' });
        }}
      >
        <p>All tasks, staff changes, notifications and audit entries made in this browser are replaced with the original sample data. The simulated clock returns to now.</p>
      </ConfirmDialog>
    </>
  );
}
