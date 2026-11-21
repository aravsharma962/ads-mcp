import ActionsView from "@/components/actions/ActionsView";

export const metadata = { title: "Actions" };

export default async function Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return <ActionsView clientId={clientId} />;
}
