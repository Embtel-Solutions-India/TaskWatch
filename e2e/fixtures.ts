// Values shared by the e2e server launcher and the browser specs. No side effects: safe to import anywhere.
/** Password of the e2e people; test data only, never a real credential. */
export const E2E_PASSWORD = 'e2e-password-42';
export const STAFF = { id: 1, name: 'Eve Staff', email: 'e2e1@example.com' };
export const MANAGER = { id: 2, name: 'Max Manager', email: 'e2e2@example.com' };
/** ADR-0014 escalation spec: CoS (dev clock) → GM (heads BAIS) → Lead → Worker. Separate from the auth spec's people. */
export const COS = { id: 3, name: 'Cora CoS', email: 'e2e3@example.com' };
export const GM = { id: 4, name: 'Gina General', email: 'e2e4@example.com' };
export const LEAD = { id: 5, name: 'Leo Lead', email: 'e2e5@example.com' };
export const WORKER = { id: 6, name: 'Wes Worker', email: 'e2e6@example.com' };

/** The e2e database: the dev server and credentials from DATABASE_URL, the database name forced to taskwatch_e2e. */
export function e2eDatabaseUrl(databaseUrl: string | undefined): string {
  const url = new URL(String(databaseUrl).replace(/^p+ostgres(ql)?:/, 'postgres:'));
  url.pathname = '/taskwatch_e2e';
  return url.toString();
}
