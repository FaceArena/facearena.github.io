import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const allowedOrigins = new Set([
  "https://facearena.github.io",
  "https://face-arena-cloudflare.pages.dev",
]);

function corsHeaders(origin: string | null) {
  const isAllowedOrigin = !!origin && (
    allowedOrigins.has(origin) ||
    /^https:\/\/[a-z0-9-]+\.face-arena-cloudflare\.pages\.dev$/i.test(origin)
  );
  const allowed = isAllowedOrigin ? origin : "https://facearena.github.io";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: Record<string, unknown>, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function listFilesRecursively(
  admin: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const files: string[] = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit, offset, sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`Не удалось проверить файлы аккаунта: ${error.message}`);
    const entries = data || [];
    for (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id == null && entry.metadata == null) files.push(...await listFilesRecursively(admin, bucket, path));
      else files.push(path);
    }
    if (entries.length < limit) break;
    offset += entries.length;
  }
  return files;
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, headers);
  try {
    const token = (req.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return json({ error: "Требуется авторизация." }, 401, headers);
    const body = await req.json().catch(() => ({}));
    if (body?.confirmation !== "DELETE") return json({ error: "Подтверждение удаления не пройдено." }, 400, headers);

    const authClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Сеанс истёк. Войдите снова и повторите попытку." }, 401, headers);

    const userId = authData.user.id;
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const paths = [
      ...await listFilesRecursively(admin, "arena-photos", userId),
      ...await listFilesRecursively(admin, "arena-photos", `moderation-pending/${userId}`),
    ];
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await admin.storage.from("arena-photos").remove(paths.slice(i, i + 100));
      if (error) throw new Error(`Не удалось удалить файлы аккаунта: ${error.message}`);
    }

    const { data: cleanup, error: cleanupError } = await admin.rpc("prepare_arena_account_deletion", { p_user_id: userId });
    if (cleanupError) throw new Error(`Не удалось безопасно обработать историю боёв: ${cleanupError.message}`);
    const { error: deleteError } = await admin.auth.admin.deleteUser(userId, false);
    if (deleteError) throw new Error(`Не удалось удалить учётную запись: ${deleteError.message}`);

    return json({
      ok: true,
      removed_files: paths.length,
      cancelled_active_battles: cleanup?.cancelled_active_battles ?? 0,
      anonymized_photos: cleanup?.anonymized_photos ?? 0,
    }, 200, headers);
  } catch (error) {
    console.error("[delete-arena-account]", error);
    return json({ error: error instanceof Error ? error.message : "Не удалось удалить аккаунт. Попробуйте позже." }, 500, headers);
  }
});
