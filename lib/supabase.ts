import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (client) return client
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('Missing SUPABASE_URL')
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')
  client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  return client
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const real = getClient() as unknown as Record<string | symbol, unknown>
    const value = real[prop]
    return typeof value === 'function' ? value.bind(real) : value
  },
})
