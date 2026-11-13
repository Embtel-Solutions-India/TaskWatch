// In-memory database persisted to localStorage, plus the demo clock and session.
import type { Db } from '../../types';
import { runTicks } from '../core';
import { createSeed, DB_VERSION } from './seed';
import { resolvePolicy } from '@taskwatch/shared/policy';
import { DEFAULT_RULES } from '../../constants';

const DB_KEY = 'taskwatch.prototype.db';
const SESSION_KEY = 'taskwatch.prototype.session';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the prototype keeps working in memory */
  }
}

function load(): Db {
  const raw = typeof localStorage === 'undefined' ? null : safeGet(DB_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Db;
      // ADR-0014: a store saved before new rule fields existed gets them from the defaults, without a reseed.
      if (parsed.version === DB_VERSION) return { ...parsed, rules: resolvePolicy(DEFAULT_RULES, parsed.rules) };
    } catch {
      /* corrupt: reseed */
    }
  }
  return createSeed(Date.now());
}

let db: Db = load();
let rev = 0;
const listeners = new Set<() => void>();

export function getDb(): Db {
  return db;
}
export function getRev(): number {
  return rev;
}
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Persist and notify subscribers. Call after every successful mutation. */
export function commit(): void {
  rev++;
  safeSet(DB_KEY, JSON.stringify(db));
  listeners.forEach((l) => l());
}

/** Server mode: server time minus browser time at the last /api/me, so countdowns follow the engine's clock (incl. the dev clock). */
let serverSkewMs = 0;
export function setServerTime(iso: string): void {
  const t = Date.parse(iso);
  if (Number.isFinite(t)) serverSkewMs = t - Date.now();
}

export function now(): number {
  return Date.now() + db.clockOffsetMs + serverSkewMs;
}

export function tick(): void {
  const sig = () => `${db.escalations.length}/${db.tasks.length}/${db.notifications.length}/${db.deliveries.filter((d) => d.status === 'held').length}/${db.deliveries.length}`;
  const before = sig();
  runTicks(db, now());
  if (sig() !== before) commit();
}

export function resetDb(): void {
  db = createSeed(Date.now());
  commit();
}

/** Replace the database (demo scenarios). */
export function replaceDb(next: Db): void {
  db = next;
  commit();
}

export interface Session {
  userId: string;
  startedAt: number;
  lastActive: number;
}

export function getSession(): Session | null {
  const raw = safeGet(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}
export function setSession(s: Session | null): void {
  safeSet(SESSION_KEY, s ? JSON.stringify(s) : null);
}
