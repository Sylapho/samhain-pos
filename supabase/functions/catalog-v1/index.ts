import { catalogDependencies, handleCatalog } from '../_shared/catalogHttp.ts'
const dependencies = catalogDependencies(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)
Deno.serve((request) => handleCatalog(request, dependencies))
