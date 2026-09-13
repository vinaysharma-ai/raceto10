import { createClient } from "@/lib/supabase/server";

export default async function SupabaseTestPage() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();

  return (
    <main className="min-h-screen p-10">
      <h1 className="text-3xl font-bold">Supabase Connection Test</h1>

      <div className="mt-6 rounded-xl border p-6">
        {error ? (
          <>
            <p className="font-semibold">Supabase is responding.</p>
            <p className="mt-2 text-sm text-gray-500">
              No authenticated user exists yet. That is expected.
            </p>
            <p className="mt-4 text-sm">{error.message}</p>
          </>
        ) : (
          <>
            <p className="font-semibold text-green-600">
              Supabase connection works.
            </p>
            <pre className="mt-4 overflow-auto text-sm">
              {JSON.stringify(data.user, null, 2)}
            </pre>
          </>
        )}
      </div>
    </main>
  );
}