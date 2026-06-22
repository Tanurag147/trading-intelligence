import type { ProposalCard } from './proposal'

/**
 * Shared Bot API POST. Throws on a non-2xx (repo convention: fail loud).
 * Returns the parsed JSON envelope so callers can read `result` fields like
 * message_id. New helpers use this; sendMessage keeps its original body.
 */
async function telegramApi(method: string, payload: unknown): Promise<unknown> {
  const token = process.env.TRADING_BOT_TOKEN
  if (!token) throw new Error('Missing TRADING_BOT_TOKEN')

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Telegram ${method} failed: ${res.status} ${body}`)
  }
  return res.json()
}

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

export type ProposalAction = 'approve' | 'skip' | 'snooze'

/**
 * Human-readable Markdown summary of a proposal card. Exported so the callback
 * handler can re-render the same body when it locks in an outcome. The AI thesis
 * is placed on its own line (not wrapped in Markdown emphasis) to avoid breaking
 * legacy-Markdown parsing on stray underscores/asterisks in generated text.
 */
export function formatProposalCard(card: ProposalCard): string {
  const dir = card.direction === 'long' ? '🟢 LONG' : '🔴 SHORT'
  return [
    `*Proposal — ${card.symbol}* (${card.setup})`,
    `${dir} · Quality ${card.quality_score}/10`,
    `Regime: tier ${card.regime.tier} ${card.regime.label}`,
    `Net ${card.expectancy.net_r}R (gross ${card.expectancy.gross_r}R) · sample: ${card.sample_confidence} (n=${card.setup_sample_size})`,
    `Entry $${card.entry_price} · Stop $${card.exit.stop_price} · Target $${card.exit.target_price}`,
    `Size ${card.position_size} · Risk ${card.risk_amount} ${card.currency}`,
    `Cluster ${card.correlation_cluster} · Hold ~${card.expected_hold_days}d`,
    ``,
    card.ai_thesis,
  ].join('\n')
}

const ACTION_LABELS: Record<ProposalAction, string> = {
  approve: '✅ Approve',
  skip: '⏭ Skip',
  snooze: '⏱ Snooze 15m',
}

/**
 * Send a proposal card with approve/skip/snooze inline buttons.
 *
 * callback_data = `v3:<action>:<proposal_id>` — short, well under Telegram's
 * 64-byte cap (the 64-hex nonce can't fit, so it's looked up server-side by
 * (proposal_id, action) and burned via verifyAndBurnNonce for single-use).
 *
 * A button renders ONLY if its nonce was minted (non-empty in `nonces`), so the
 * UI can never offer an action with no backing single-use token.
 *
 * Returns the sent message_id, needed to edit the card to its locked outcome.
 */
export async function sendProposalCard(
  chatId: string,
  card: ProposalCard,
  nonces: { approve: string; skip: string; snooze: string }
): Promise<{ message_id: number }> {
  const actions: ProposalAction[] = ['approve', 'skip', 'snooze']
  const buttons = actions
    .filter((a) => Boolean(nonces[a]))
    .map((a) => ({
      text: ACTION_LABELS[a],
      callback_data: `v3:${a}:${card.proposal_id}`,
    }))

  const json = (await telegramApi('sendMessage', {
    chat_id: chatId,
    text: formatProposalCard(card),
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [buttons] },
  })) as { result?: { message_id?: number } }

  const message_id = json.result?.message_id
  if (typeof message_id !== 'number') {
    throw new Error('Telegram sendProposalCard: no message_id in response')
  }
  return { message_id }
}

/** Stop Telegram's button loading spinner; optional toast text to the tapper. */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<void> {
  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  })
}

/**
 * Rewrite a previously-sent message and strip its inline keyboard. Used to lock
 * a card to its decided outcome (or mark it void) so the buttons can't be tapped
 * again from the client.
 */
export async function editMessageText(
  chatId: string,
  messageId: number,
  text: string,
  parseMode: 'Markdown' | 'HTML' = 'Markdown'
): Promise<void> {
  await telegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: parseMode,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  })
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
