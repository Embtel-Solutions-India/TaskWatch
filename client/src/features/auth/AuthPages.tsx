import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { ROLE_LABEL } from "../../constants";
import { Icon } from "../../components/icons";
import { Avatar, Banner, Button, Field, Input } from "../../components/ui";
import { useDocumentTitle } from "../../hooks";
import { ThemeButton } from "../../app/Shell";
import { ApiError } from "../../services/authz/permissions";
import {
  DEMO_PASSWORD,
  login,
  requestPasswordReset,
  resetPassword,
} from "../../services/api/misc";
import { getDb } from "../../services/mock/store";
import { sessionApi } from "../../services/api/session";
import { BACKEND } from "../../services/http";
import illustration from "../../assets/login-art.png";

function AuthFrame({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: ReactNode;
  children: ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <div className="auth">
      <div className="auth-theme">
        <ThemeButton />
      </div>
      <div className="auth-panel">
        {/* Owner's sign-in design (2026-11-11): the form sits in a deep-blue card on a plain white or black page. */}
        <div className="auth-card">
          <div className="brand auth-brand">
            <span className="brand-mark" aria-hidden>
              <Icon name="check" size={16} />
            </span>
            <span className="brand-text">
              <strong>TaskWatch</strong>
            </span>
          </div>
          <h1>{title}</h1>
          {sub && <p className="muted">{sub}</p>}
          {children}
        </div>
      </div>
      <aside className="auth-side auth-art" aria-hidden>
        {/* Owner's sign-in illustration (2026-11-11, transparent): "Stay on top of work, never miss a deadline." is part of the image. */}
        <img src={illustration} alt="" />
      </aside>
    </div>
  );
}

/** Email and password with icons, a show/hide toggle and the submit button: one form for the prototype and the server. */
function CredentialFields({ email, setEmail, password, setPassword, err, busy }: { email: string; setEmail: (v: string) => void; password: string; setPassword: (v: string) => void; err: ApiError | null; busy: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <>
      <Field label="Work email" htmlFor="email" error={err?.fields?.email}>
        <span className="input-icon">
          <Icon name="mail" size={17} />
          <Input id="email" type="email" autoComplete="username" placeholder="Enter your work email" value={email} onChange={(e) => setEmail(e.target.value)} invalid={!!err?.fields?.email} autoFocus />
        </span>
      </Field>
      <Field label="Password" htmlFor="password" error={err?.fields?.password}>
        <span className="input-icon">
          <Icon name="lock" size={17} />
          <Input id="password" type={show ? 'text' : 'password'} autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!err?.fields?.password} />
          <button type="button" className="input-icon-btn" onClick={() => setShow((v) => !v)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
            <Icon name={show ? 'eye-off' : 'eye'} size={17} />
          </button>
        </span>
      </Field>
      <div className="row-between">
        <Link to="/forgot-password">Forgot password?</Link>
      </div>
      <Button type="submit" variant="primary" size="lg" loading={busy}>
        Sign in <Icon name="arrow" size={16} />
      </Button>
    </>
  );
}

export function LoginPage({ onLogin }: { onLogin: () => Promise<void> }) {
  return BACKEND === "server" ? (
    <ServerLogin onLogin={onLogin} />
  ) : (
    <MockLogin onLogin={onLogin} />
  );
}

function MockLogin({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? "/";
  const db = getDb();
  const demoUsers = ["u-ceo", "u-cos", "u-m1", "u-l1", "u-s1"]
    .map((id) => db.users.find((u) => u.id === id)!)
    .filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    await new Promise((r) => setTimeout(r, 250));
    try {
      login(email, password);
      onLogin();
      nav(from === "/login" ? "/" : from, { replace: true });
    } catch (x) {
      setErr(x as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" sub={`Welcome back to ${db.settings.orgName}.`}>
      <form onSubmit={submit} noValidate className="stack">
        {err && err.status !== 422 && (
          <Banner tone="danger">{err.message}</Banner>
        )}
        <CredentialFields email={email} setEmail={setEmail} password={password} setPassword={setPassword} err={err} busy={busy} />
      </form>
      <div className="demo-login">
        <p className="eyebrow">
          <Icon name="zap" size={12} /> Demo accounts — prototype only
        </p>
        <p className="muted small">
          Every account uses the password <code>{DEMO_PASSWORD}</code>.
          Authentication is simulated in the browser.
        </p>
        <div className="demo-login-grid">
          {demoUsers.map((u) => (
            <button
              key={u.id}
              type="button"
              className="demo-user"
              onClick={() => {
                setEmail(u.email);
                setPassword(DEMO_PASSWORD);
              }}
            >
              <Avatar name={u.name} size={26} />
              <span>
                <strong>{u.name}</strong>
                <small>{ROLE_LABEL[u.role]}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </AuthFrame>
  );
}

/* ---------- Server mode (T-2.7): the real sign-in (password, Google, dev; no 2FA: D-94) ---------- */

/** Wait for the signed-in state before navigating, so the sign-in page never flashes back (T-2.7). */
function useAfterSignIn(onLogin: () => Promise<void>) {
  const nav = useNavigate();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from ?? "/";
  return async () => {
    await onLogin();
    nav(from === "/login" ? "/" : from, { replace: true });
  };
}

function ServerLogin({ onLogin }: { onLogin: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<{ google: boolean; devLogin: boolean } | null>(
    null,
  );
  const [devUsers, setDevUsers] = useState<
    { id: number; name: string; title: string | null }[]
  >([]);
  const [params] = useSearchParams();
  const done = useAfterSignIn(onLogin);

  useEffect(() => {
    sessionApi.config().then(
      (c) => {
        setCfg(c);
        if (c.devLogin) sessionApi.devUsers().then(setDevUsers, () => {});
      },
      () => {},
    );
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await sessionApi.login(email, password);
      await done();
    } catch (x) {
      setErr(x as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const googleError = params.get("error");
  return (
    <AuthFrame title="Sign in" sub="Access your TaskWatch account.">
      <form onSubmit={submit} noValidate className="stack">
        {googleError && !err && <Banner tone="danger">{googleError}</Banner>}
        {err && err.status !== 422 && (
          <Banner tone="danger">{err.message}</Banner>
        )}
        <CredentialFields email={email} setEmail={setEmail} password={password} setPassword={setPassword} err={err} busy={busy} />
        {cfg?.google && (
          <a href="/api/auth/google" className="btn btn-lg">
            Sign in with Google
          </a>
        )}
      </form>
      {cfg?.devLogin && devUsers.length > 0 && (
        <div className="demo-login">
          <p className="eyebrow">
            <Icon name="zap" size={12} /> Development sign-in — never available
            in production
          </p>
          <div className="demo-login-grid">
            {devUsers.map((u) => (
              <button
                key={u.id}
                type="button"
                className="demo-user"
                onClick={() =>
                  sessionApi
                    .devLogin(u.id)
                    .then(done, (x) => setErr(x as ApiError))
                }
              >
                <Avatar name={u.name} size={26} />
                <span>
                  <strong>{u.name}</strong>
                  <small>{u.title}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </AuthFrame>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [sent, setSent] = useState<{ token: string | null } | null>(null);
  return (
    <AuthFrame
      title="Reset your password"
      sub="Enter your work email and we'll send a reset link."
    >
      {sent ? (
        <div className="stack">
          <Banner tone="ok">
            If an account exists for {email}, a reset link has been issued.
          </Banner>
          {sent.token && (
            <Banner tone="info" icon="zap">
              Prototype: no email is actually sent.{" "}
              <Link to={`/reset-password?token=${sent.token}`}>
                Open the simulated reset link
              </Link>
              .
            </Banner>
          )}
          <Link to="/login">Back to sign in</Link>
        </div>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              if (BACKEND === "server") {
                await sessionApi.forgot(email); // the link goes only to the inbox
                setSent({ token: null });
              } else setSent({ token: requestPasswordReset(email) });
            } catch (x) {
              setErr(x as ApiError);
            }
          }}
        >
          <Field label="Work email" htmlFor="femail" error={err?.fields?.email}>
            <Input
              id="femail"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              invalid={!!err?.fields?.email}
              autoFocus
            />
          </Field>
          <Button type="submit" variant="primary">
            Send reset link
          </Button>
          <Link to="/login">Back to sign in</Link>
        </form>
      )}
    </AuthFrame>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  return (
    <AuthFrame title="Choose a new password">
      {done ? (
        <div className="stack">
          <Banner tone="ok">Your password has been reset.</Banner>
          {BACKEND === "mock" && (
            <Banner tone="info" icon="zap">
              Prototype: passwords are not stored. Continue to sign in with{" "}
              <code>{DEMO_PASSWORD}</code>.
            </Banner>
          )}
          <Link to="/login" className="btn btn-primary">
            Go to sign in
          </Link>
        </div>
      ) : (
        <form
          className="stack"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              if (BACKEND === "server")
                await sessionApi.reset(token, pw, confirm);
              else resetPassword(token, pw, confirm);
              setDone(true);
            } catch (x) {
              setErr(x as ApiError);
            }
          }}
        >
          {!token && (
            <Banner tone="warn">
              This page needs a reset token. Request a new link from the sign-in
              page.
            </Banner>
          )}
          {err && err.status !== 422 && (
            <Banner tone="danger">{err.message}</Banner>
          )}
          <Field
            label="New password"
            htmlFor="pw"
            hint="At least 10 characters, with letters and a number."
            error={err?.fields?.password}
          >
            <Input
              id="pw"
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              invalid={!!err?.fields?.password}
            />
          </Field>
          <Field
            label="Confirm password"
            htmlFor="pw2"
            error={err?.fields?.confirm}
          >
            <Input
              id="pw2"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              invalid={!!err?.fields?.confirm}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={!token}>
            Reset password
          </Button>
        </form>
      )}
    </AuthFrame>
  );
}

export function SessionExpiredPage() {
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from;
  return (
    <AuthFrame
      title="Your session expired"
      sub="For security, you were signed out after a period of inactivity."
    >
      <Link to="/login" state={{ from }} className="btn btn-primary btn-lg">
        Sign in again
      </Link>
    </AuthFrame>
  );
}
