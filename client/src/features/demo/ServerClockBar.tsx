// Server mode (T-10.1, DEMO-01): the dev clock only. The server sends `demo` in /api/me only when DEMO_TOOLS=true
// outside production (D-47), and answers /api/dev/clock for the CoS only (D-17). Act-as, scenarios, expire and reset
// stay prototype-only. G-8: a non-zero offset moves server time for everyone, so everyone sees this bar then.
import { Icon } from '../../components/icons';
import { useAction, useAuth } from '../../hooks';
import { http } from '../../services/http';
import { formatDateTime, hoursLabel } from '../../utils/format';

const setClock = (body: { advanceHours: number } | { reset: true }) => http<{ offsetHours: number }>('POST', '/dev/clock', body);

export function ServerClockBar() {
  const { bootstrap } = useAuth();
  const move = useAction(setClock, { success: (r) => (r.offsetHours ? `Clock at +${hoursLabel(r.offsetHours)}; escalation engine ran.` : 'Clock back to now.') });
  const demo = bootstrap?.demo;
  const isCos = bootstrap?.user.roles.includes('cos') ?? false;
  if (!bootstrap || !demo || (!isCos && demo.offsetHours === 0)) return null;
  return (
    <div className="demobar" role="region" aria-label="Development clock">
      <span className="demobar-tag">
        <Icon name="zap" size={13} /> Dev clock
        <span className="demobar-note">Development only. The offset applies to every user.</span>
      </span>
      <span className="demobar-clock" title="Server time used by the escalation engine">
        <Icon name="clock" size={13} /> {formatDateTime(bootstrap.serverTime)}
        {demo.offsetHours > 0 && <strong> (+{hoursLabel(demo.offsetHours)})</strong>}
      </span>
      {isCos && (
        <span className="demobar-group" role="group" aria-label="Advance server time">
          {[1, 4, 12, 24].map((h) => (
            <button key={h} type="button" disabled={move.pending} onClick={() => move.run({ advanceHours: h })}>
              +{h}h
            </button>
          ))}
          <button type="button" disabled={move.pending || demo.offsetHours === 0} onClick={() => move.run({ reset: true })}>
            Now
          </button>
        </span>
      )}
    </div>
  );
}
