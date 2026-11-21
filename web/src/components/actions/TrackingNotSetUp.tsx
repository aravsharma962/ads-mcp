import Link from "next/link";

export default function TrackingNotSetUp({ clientId, what }: { clientId: string; what: string }) {
  return (
    <div className="rounded border p-4 text-sm">
      <p className="font-medium">Tracking not set up</p>
      <p className="mt-1 text-gray-600">{what} come from the first-party tracker on the client&apos;s website, which is not installed yet.</p>
      <Link href={`/clients/${clientId}/tracking`} className="mt-2 inline-block underline">Set up tracking</Link>
    </div>
  );
}
