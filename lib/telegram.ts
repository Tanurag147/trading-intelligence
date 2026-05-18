export async function sendMessage(
  chatId: string,
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<void> {
  const token = process.env.TRADING_BOT_TOKEN
  if (!token) throw new Error('Missing TRADING_BOT_TOKEN')

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`)
  }
}

export function regimeEmoji(regime: string): string {
  switch (regime) {
    case 'trending_up':
      return '📈'
    case 'trending_down':
      return '📉'
    case 'ranging':
      return '↔️'
    case 'volatile':
      return '⚡'
    default:
      return '❔'
  }
}
