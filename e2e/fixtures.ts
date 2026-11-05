// Values shared by the e2e server launcher and the browser specs. No side effects: safe to import anywhere.
/** Password of the e2e people; test data only, never a real credential. */
export const E2E_PASSWORD = 'e2e-password-42';
export const STAFF = { id: 1, name: 'Eve Staff', email: 'e2e1@example.com' };
export const MANAGER = { id: 2, name: 'Max Manager', email: 'e2e2@example.com' };

/** The e2e database: the dev server and credentials from DATABASE_URL, the database name forced to taskwatch_e2e. */
export function e2eDatabaseUrl(databaseUrl: string | undefined): string {
  const url = new URL(String(databaseUrl).replace(/^p+ostgres(ql)?:/, 'postgres:'));
  url.pathname = '/taskwatch_e2e';
  return url.toString();
}
