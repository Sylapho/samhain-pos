import { handleSync, syncDependencies } from '../_shared/syncHttp.ts'
const deps = syncDependencies(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
Deno.serve((request) => handleSync(request, 'ledger-ingest-v1', deps))
