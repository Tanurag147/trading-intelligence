import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock the supabase singleton Proxy: NO network ever happens ------------
// We model three chains used by lib/nonce.ts:
//   insert:  from(T).insert(row)                                   -> { error }
//   read:    from(T).select(...).eq('nonce', x).maybeSingle()      -> { data, error }
//   burn:    from(T).update(...).eq('nonce', x).is('used_at', null)
//                            .select('nonce')                      -> { data, error }
const {
  fromMock,
  insertMock,
  selectMock,
  maybeSingleMock,
  updateMock,
  burnEqMock,
  burnIsMock,
  burnSelectMock,
} = vi.hoisted(() => {
  const insertMock = vi.fn();
  const maybeSingleMock = vi.fn();
  const updateMock = vi.fn();
  const burnEqMock = vi.fn();
  const burnIsMock = vi.fn();
  const burnSelectMock = vi.fn();
  const selectMock = vi.fn();

  // read chain: select().eq().maybeSingle()
  const readBuilder = { eq: vi.fn(() => readBuilder), maybeSingle: maybeSingleMock };
  selectMock.mockReturnValue(readBuilder);

  // burn chain: update().eq().is().select()
  const burnBuilder = { eq: burnEqMock, is: burnIsMock, select: burnSelectMock };
  burnEqMock.mockReturnValue(burnBuilder);
  burnIsMock.mockReturnValue(burnBuilder);
  updateMock.mockReturnValue(burnBuilder);

  const fromObj = { insert: insertMock, select: selectMock, update: updateMock };
  const fromMock = vi.fn(() => fromObj);
  return {
    fromMock,
    insertMock,
    selectMock,
    maybeSingleMock,
    updateMock,
    burnEqMock,
    burnIsMock,
    burnSelectMock,
  };
});
vi.mock('../supabase', () => ({ supabase: { from: fromMock } }));

import { mintNonce, verifyAndBurnNonce } from '../nonce';

const TABLE = 'trading_callback_nonces';
const FUTURE = 1_900_000_000_000; // 2030
const PAST = 1_000_000_000_000; // 2001

beforeEach(() => {
  fromMock.mockClear();
  insertMock.mockReset();
  insertMock.mockResolvedValue({ error: null });
  maybeSingleMock.mockReset();
  updateMock.mockClear();
  burnEqMock.mockClear();
  burnIsMock.mockClear();
  burnSelectMock.mockReset();
  burnSelectMock.mockResolvedValue({ data: [{ nonce: 'n' }], error: null });
});

describe('mintNonce', () => {
  it('inserts a row and returns a >=32 char nonce', async () => {
    const nonce = await mintNonce({
      proposal_id: 'p_1',
      action: 'approve',
      telegram_user_id: '42',
      expires_at: FUTURE,
    });

    expect(typeof nonce).toBe('string');
    expect(nonce.length).toBeGreaterThanOrEqual(32);
    expect(fromMock).toHaveBeenCalledWith(TABLE);
    const row = insertMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(row.nonce).toBe(nonce);
    expect(row.proposal_id).toBe('p_1');
    expect(row.action).toBe('approve');
    expect(row.telegram_user_id).toBe('42');
    expect(row.expires_at).toBe(new Date(FUTURE).toISOString());
  });

  it('returns distinct nonces across calls', async () => {
    const a = await mintNonce({ proposal_id: 'p', action: 'skip', telegram_user_id: '1', expires_at: FUTURE });
    const b = await mintNonce({ proposal_id: 'p', action: 'skip', telegram_user_id: '1', expires_at: FUTURE });
    expect(a).not.toBe(b);
  });

  it('throws when the insert errors (fail-closed)', async () => {
    insertMock.mockResolvedValue({ error: new Error('insert boom') });
    await expect(
      mintNonce({ proposal_id: 'p', action: 'approve', telegram_user_id: '1', expires_at: FUTURE }),
    ).rejects.toThrow('insert boom');
  });
});

describe('verifyAndBurnNonce', () => {
  function readRow(over: Record<string, unknown> = {}) {
    maybeSingleMock.mockResolvedValue({
      data: {
        proposal_id: 'p_1',
        action: 'approve',
        telegram_user_id: '42',
        expires_at: new Date(FUTURE).toISOString(),
        used_at: null,
        ...over,
      },
      error: null,
    });
  }

  it('happy path returns ok and issues a conditional (used_at IS NULL) burn', async () => {
    readRow();
    const res = await verifyAndBurnNonce({ nonce: 'n1', expected_action: 'approve', telegram_user_id: '42' });

    expect(res).toEqual({ ok: true, proposal_id: 'p_1', action: 'approve' });
    // the burn update set used_at...
    const payload = updateMock.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(payload.used_at).toBeTruthy();
    // ...gated on used_at IS NULL (the single-use lock).
    expect(burnIsMock).toHaveBeenCalledWith('used_at', null);
    expect(burnEqMock).toHaveBeenCalledWith('nonce', 'n1');
  });

  it('not_found when the row does not exist', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    const res = await verifyAndBurnNonce({ nonce: 'nope', expected_action: 'approve', telegram_user_id: '42' });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('user_mismatch when telegram_user_id differs', async () => {
    readRow({ telegram_user_id: '999' });
    const res = await verifyAndBurnNonce({ nonce: 'n1', expected_action: 'approve', telegram_user_id: '42' });
    expect(res).toEqual({ ok: false, reason: 'user_mismatch' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('already_used when used_at is already set', async () => {
    readRow({ used_at: new Date(PAST).toISOString() });
    const res = await verifyAndBurnNonce({ nonce: 'n1', expected_action: 'approve', telegram_user_id: '42' });
    expect(res).toEqual({ ok: false, reason: 'already_used' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('expired when now is past expires_at', async () => {
    readRow({ expires_at: new Date(PAST).toISOString() });
    const res = await verifyAndBurnNonce({ nonce: 'n1', expected_action: 'approve', telegram_user_id: '42' });
    expect(res).toEqual({ ok: false, reason: 'expired' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('action mismatch returns not_found (no leak of the real action)', async () => {
    readRow({ action: 'approve' });
    const res = await verifyAndBurnNonce({ nonce: 'n1', expected_action: 'skip', telegram_user_id: '42' });
    expect(res).toEqual({ ok: false, reason: 'not_found' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('concurrent burn: conditional update touches 0 rows => already_used', async () => {
    readRow();
    burnSelectMock.mockResolvedValue({ data: [], error: null }); // race lost
    const res = await verifyAndBurnNonce({ nonce: 'n1', expected_action: 'approve', telegram_user_id: '42' });
    expect(res).toEqual({ ok: false, reason: 'already_used' });
    expect(burnIsMock).toHaveBeenCalledWith('used_at', null);
  });

  it('throws when the read errors', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error('read boom') });
    await expect(
      verifyAndBurnNonce({ nonce: 'n1', expected_action: 'approve', telegram_user_id: '42' }),
    ).rejects.toThrow('read boom');
  });

  it('throws when the burn errors', async () => {
    readRow();
    burnSelectMock.mockResolvedValue({ data: null, error: new Error('burn boom') });
    await expect(
      verifyAndBurnNonce({ nonce: 'n1', expected_action: 'approve', telegram_user_id: '42' }),
    ).rejects.toThrow('burn boom');
  });
});
