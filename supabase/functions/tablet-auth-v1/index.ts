import {
  AuthFailure,
  handleTabletAuth,
  principalFromVerifiedUser,
  type Rpc,
} from '../_shared/tabletAuth.ts'

const origin = Deno.env.get('SUPABASE_URL')!
const serverKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const rpc: Rpc = async (subject, action, body, nonce) => {
  const response = await fetch(`${origin}/rest/v1/rpc/tablet_auth_v1`, {
    method: 'POST',
    headers: {
      apikey: serverKey,
      Authorization: `Bearer ${serverKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ subject, action, body, proof_nonce: nonce ?? null }),
  })
  if (!response.ok) throw new AuthFailure('AUTHORIZATION_DENIED', 403)
  return response.json()
}

Deno.serve((request) =>
  handleTabletAuth(request, {
    rpc,
    authenticate: async (jwt) => {
      const response = await fetch(`${origin}/auth/v1/user`, {
        headers: { apikey: serverKey, Authorization: `Bearer ${jwt}` },
      })
      if (!response.ok) throw new AuthFailure('SESSION_EXPIRED', 401)
      const user = await response.json()
      if (
        typeof user.id !== 'string' ||
        (user.banned_until && Date.parse(user.banned_until) > Date.now())
      )
        throw new AuthFailure('AUTH_REQUIRED', 401)
      return principalFromVerifiedUser(user, jwt)
    },
  }),
)
