import PagesView from "@/components/actions/PagesView";

export const metadata = { title: "Site pages" };

export default async function Page({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return <PagesView clientId={clientId} />;
}
