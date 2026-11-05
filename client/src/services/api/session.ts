// Sign-in, password reset and the /api/me bootstrap against the real server (T-2.7; API_CONTRACTS, AUTH-FRD).
// Used only when BACKEND === 'server'; the prototype's mock auth stays in misc.ts.
import { ROLE_RANK } from '../../constants';
import type { Permission, Role, User } from '../../types';
import { http } from '../http';

export interface Bootstrap {
  user: {
    id: number;
    name: string;
    email: string;
    title: string | null;
    roles: Role[];
    entityId: string;
    entityName: string | null;
    team: { id: number; name: string } | null;
    timezone: string;
    zone: string;
    manager: { id: number; name: string } | null;
  };
  permissions: Permission[];
  settings: { orgName: string; timezone: string; categories: string[]; sessionTimeoutMinutes: number; workdayStart: string; workdayEnd: string };
  badges: { unread: number; escalations: number; reviews: number; extensions: number };
  integrations: { google: boolean; whatsapp: boolean; email: boolean; devLogin: boolean };
  demo: { offsetHours: number } | null;
  serverTime: string;
}

/**
 * The screens still use the prototype's User shape (string ids, one role). The highest-ranked role stands in for
 * the person here; the full roles and permissions travel alongside in the auth context.
 */
export function toClientUser(b: Bootstrap): User {
  const u = b.user;
  const role = [...u.roles].sort((a, c) => ROLE_RANK[c] - ROLE_RANK[a])[0] ?? 'staff';
  return {
    id: String(u.id),
    name: u.name,
    email: u.email,
    title: u.title ?? '',
    role,
    managerId: u.manager ? String(u.manager.id) : null,
    teamId: u.team ? String(u.team.id) : null,
    status: 'active',
    joinedAt: '',
    location: '',
    phone: '',
    whatsapp: null,
    whatsappOptIn: false,
    timezone: u.timezone,
  };
}

export const sessionApi = {
  config: () => http<{ google: boolean; devLogin: boolean }>('GET', '/auth/config'),
  me: () => http<Bootstrap>('GET', '/me'),
  login: (email: string, password: string) => http<{ ok: true }>('POST', '/auth/login', { email, password }),
  forgot: (email: string) => http<{ ok: true }>('POST', '/auth/password/forgot', { email }),
  reset: (token: string, password: string, confirm: string) => http<{ ok: true }>('POST', '/auth/password/reset', { token, password, confirm }),
  logout: () => http<{ ok: true }>('POST', '/auth/logout'),
  devUsers: () => http<{ id: number; name: string; title: string | null; roles: Role[] }[]>('GET', '/auth/dev-users'),
  devLogin: (userId: number) => http<{ ok: true }>('POST', '/auth/dev-login', { userId }),
};
