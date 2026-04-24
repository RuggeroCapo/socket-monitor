import DashboardShell from '@/components/DashboardShell';
import { loadHealthForApp, loadSnapshotForApp } from '@/lib/dashboard-source';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export default async function Page() {
  const [snapshot, health] = await Promise.all([
    loadSnapshotForApp(),
    loadHealthForApp(),
  ]);

  return <DashboardShell initialSnapshot={snapshot} initialHealth={health} />;
}
