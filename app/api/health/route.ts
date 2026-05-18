export async function GET() {
  return Response.json({
    ok: true,
    service: 'trading-intelligence',
    timestamp: new Date().toISOString(),
  })
}
