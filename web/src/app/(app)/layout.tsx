import Link from "next/link";
import { requireTenantContext, NoTenantError } from "@/lib/tenant";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let ctx;
  try {
    ctx = await requireTenantContext();
  } catch (e) {
    if (e instanceof NoTenantError) {
      return (
        <main className="mx-auto mt-24 max-w-md rounded bg-white p-6 shadow">
          <h1 className="mb-2 text-lg font-semibold">No agency access</h1>
          <p className="text-sm">{e.message}</p>
          <form action="/api/auth/logout" method="post" className="mt-4">
            <button className="rounded border px-3 py-1 text-sm">Sign out</button>
          </form>
        </main>
      );
    }
    throw e;
  }
  return (
    <div>
      <header className="flex items-center justify-between border-b bg-white px-6 py-3">
        <nav className="flex gap-4 text-sm">
          <Link href="/clients" className="font-semibold">Clients</Link>
          {ctx.role === "owner" && <Link href="/settings/team">Team</Link>}
        </nav>
        <form action="/api/auth/logout" method="post">
          <button className="text-sm text-gray-600 underline">Sign out</button>
        </form>
      </header>
      <div className="mx-auto max-w-6xl p-6">{children}</div>
    </div>
  );
}
