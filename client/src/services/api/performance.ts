// PERF (PERFORMANCE-FRD §3, §5): leaderboard, person breakdown and workload. Server only: the prototype has no scores.
import { ApiError } from '../authz/permissions';
import { BACKEND, http } from '../http';

export type PeriodKind = 'week' | 'month' | 'custom';
export interface PeriodParams {
  period: PeriodKind;
  from?: string;
  to?: string;
}
/** D-124: each task's weight in the Outcome Score, by priority (Settings). */
export interface Weights {
  critical: number;
  high: number;
  normal: number;
  low: number;
}
export interface ScoreParts {
  outcome: number | null;
  timeliness: number | null;
  quality: number | null;
  efficiency: number | null;
  efficiencyByPressure: { high: number | null; normal: number | null };
  score: number | null;
  eligible: number;
  ranked: boolean;
  flags: ('no_quality_reviews' | 'outcome_not_rated')[];
}
export interface LeaderRow extends ScoreParts {
  userId: number;
  name: string;
  rank: number | null;
}
export interface BreakdownTask {
  id: number;
  title: string;
  dueAt: string;
  completedAt: string | null;
  outcome: number | null;
  onTime: boolean;
  quality: number | null;
  reviewed: boolean;
  reworkCount: number;
  weight: number;
  excluded: null | 'not_due' | 'accepted' | 'not_rated' | 'reassigned_after_due' | 'pending_review';
}
export interface WorkloadRow {
  userId: number;
  name: string;
  openHours: number;
  windowHours: number;
  capacityHours: number;
  loadPercent: number;
  band: 'light' | 'normal' | 'overloaded';
  highShare: number;
  overdue: number;
  blocked: number;
  noEstimate: number;
}

export const SERVER_ONLY = 'Performance figures are available with the server backend.';

function get<T>(path: string): Promise<T> {
  if (BACKEND !== 'server') return Promise.reject(new ApiError(400, SERVER_ONLY));
  return http<T>('GET', path);
}

const qs = (p: PeriodParams) => new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();

export const perfTeams = () => get<{ id: number; name: string }[]>('/performance/teams');
export const leaderboard = (teamId: number, p: PeriodParams) =>
  get<{ team: { id: number; name: string }; from: string; to: string; weights: Weights; rows: LeaderRow[] }>(`/performance/leaderboard?teamId=${teamId}&${qs(p)}`);
export const personBreakdown = (id: string, p: PeriodParams) =>
  get<{ person: { id: number; name: string; teamId: number | null }; from: string; to: string; weights: Weights; score: ScoreParts; tasks: BreakdownTask[] }>(`/performance/people/${id}?${qs(p)}`);
/** The leaderboard's charts: the team's weekly average (8 weeks) and, for viewers with several teams, each team's average. */
export interface Analytics {
  trend: { from: string; to: string; average: number | null; scored: number }[];
  teams: { id: number; name: string; people: number; average: number | null; scored: number }[];
}
export const perfAnalytics = (teamId: number, p: PeriodParams) => get<Analytics>(`/performance/analytics?teamId=${teamId}&${qs(p)}`);
export const teamWorkload = (teamId: number) => get<{ team: { id: number; name: string }; rows: WorkloadRow[] }>(`/workload?teamId=${teamId}`);

/** Scores show one decimal (FRD §5); a missing part shows a dash. */
export const fmt = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1));
