import ReportView from "@/components/actions/ReportView";

export const metadata = { title: "Report" };

export default async function Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return <ReportView clientId={clientId} />;
}
