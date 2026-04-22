import DashboardShell from '@/components/DashboardShell';
import { loadHealth, loadSnapshot } from '@/lib/dashboard-data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Page() {
  const [snapshot, health] = await Promise.all([loadSnapshot(), loadHealth()]);

  return <DashboardShell initialSnapshot={snapshot} initialHealth={health} />;
}
