import { refreshQueuedDay } from '../lib/daily-analysis.mjs';

export const config = { schedule: '*/2 * * * *' };

export default async function dailyAnalysis() {
  await refreshQueuedDay();
  return new Response(null, { status: 204 });
}
