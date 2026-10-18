// The plans an account can be on (backend/migrations/00005_paid_plans.sql).

const NAMES: Record<string, string> = { free: 'Free', premium: 'Premium', max: 'Max' };

/** A plan's name as shown to the viewer; a plan this version does not know shows as it is stored. */
export function planName(plan: string): string {
  return NAMES[plan] ?? plan;
}
