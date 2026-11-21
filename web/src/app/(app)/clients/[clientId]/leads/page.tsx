import LeadsView from "@/components/actions/LeadsView";

export const metadata = { title: "Leads" };

export default async function Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return <LeadsView clientId={clientId} />;
}
