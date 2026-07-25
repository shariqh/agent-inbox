export interface LiveSessionSummary { session: string; label: string; tone: string }
export interface LiveSummary { count: number; tone: string; label: string; sessions: LiveSessionSummary[] }
export function liveSummary(activity: unknown[], nowMs: number): LiveSummary
