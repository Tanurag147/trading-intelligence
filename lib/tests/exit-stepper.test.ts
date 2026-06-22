import { describe, it, expect } from 'vitest';
import {
  initPosition,
  stepPosition,
  runToCompletion,
  type PositionState,
} from '../exit-stepper';
import type { Bar } from '../feed';
import type { ExitPlan, ProposalCard } from '../proposal';
import { cleanCard } from './factory';

// A bar builder so each test states only the prices that matter.
function bar(over: Partial<Bar> = {}): Bar {
  return { t: 1_700_000_000_000, o: 100, h: 100, l: 100, c: 100, ...over };
}

// A clean SHORT card: entry 100, stop 102 (risk 2), target 95 (reward 5 => RR 2.5).
function shortCard(over: Partial<ProposalCard> = {}): ProposalCard {
  return cleanCard({
    direction: 'short',
    entry_price: 100,
    exit: {
      stop_price: 102,
      target_price: 95,
      trail_activate_r: 1.0,
      time_stop_days: 7,
      thesis_invalidation: [],
    },
    ...over,
  });
}

describe('clean target hit', () => {
  it('long reaches target => target_hit at ~+RR', () => {
    const card = cleanCard(); // entry 100, stop 98, target 105 (RR 2.5)
    // high pierces target, low never touches stop.
    const s = stepPosition(initPosition(card), bar({ h: 106, l: 99, c: 105 }), card.exit);
    expect(s.status).toBe('target_hit');
    expect(s.exit_reason).toBe('target_hit');
    expect(s.realised_r).toBeCloseTo(2.5);
    expect(s.exit_bar_time).toBe(bar().t);
  });

  it('short reaches target => target_hit at ~+RR', () => {
    const card = shortCard();
    const s = stepPosition(initPosition(card), bar({ h: 101, l: 94, c: 95 }), card.exit);
    expect(s.status).toBe('target_hit');
    expect(s.realised_r).toBeCloseTo(2.5);
  });
});

describe('stop hit before target', () => {
  it('long stop => stopped at ~-1R', () => {
    const card = cleanCard();
    const s = stepPosition(initPosition(card), bar({ h: 101, l: 97, c: 97 }), card.exit);
    expect(s.status).toBe('stopped');
    expect(s.realised_r).toBeCloseTo(-1);
  });
});

describe('breakeven trail', () => {
  it('activates at +1R then a pullback stops out at ~0R, not -1R', () => {
    const card = cleanCard(); // +1R price = 100 + 1*(100-98) = 102
    const bars: Bar[] = [
      bar({ o: 100, h: 102, l: 100, c: 101 }), // reaches +1R, no target/stop -> trail on, stop->100
      bar({ o: 101, h: 101, l: 99, c: 99 }), // pulls back through breakeven (100)
    ];
    const s = runToCompletion(card, bars, card.exit);
    expect(s.trail_active).toBe(true);
    expect(s.status).toBe('stopped');
    expect(s.realised_r).toBeCloseTo(0); // breakeven, NOT -1
    expect(s.bars_held).toBe(2);
  });

  it('does not stop out on the very bar that activates the trail', () => {
    const card = cleanCard();
    // Bar dips to exactly breakeven (100) but only AFTER activation would move
    // the stop there — the pre-move stop (98) is what bar 1 is tested against.
    const s = stepPosition(initPosition(card), bar({ o: 100, h: 102, l: 100, c: 101 }), card.exit);
    expect(s.status).toBe('open');
    expect(s.trail_active).toBe(true);
    expect(s.current_stop).toBe(100);
  });
});

describe('time stop', () => {
  it('fires at time_stop_days with no target/stop hit', () => {
    const card = cleanCard(); // time_stop_days = 7
    // 7 quiet bars: never touch stop 98 or target 105, never reach +1R (102).
    const bars: Bar[] = Array.from({ length: 7 }, () => bar({ o: 100, h: 101, l: 99, c: 100 }));
    const s = runToCompletion(card, bars, card.exit);
    expect(s.status).toBe('time_stopped');
    expect(s.bars_held).toBe(7);
    expect(s.realised_r).toBeCloseTo(0);
  });
});

describe('thesis invalidation', () => {
  it('closes when regime_tier drops below 4', () => {
    const card = cleanCard();
    const s = stepPosition(initPosition(card), bar({ h: 101, l: 99, c: 100 }), card.exit, {
      regime_tier: 3,
    });
    expect(s.status).toBe('thesis_invalidated');
    expect(s.realised_r).toBeCloseTo(0); // exited at close 100 == entry
  });

  it('closes when thesis_broken is true', () => {
    const card = cleanCard();
    const s = stepPosition(initPosition(card), bar({ h: 101, l: 99, c: 100 }), card.exit, {
      thesis_broken: true,
    });
    expect(s.status).toBe('thesis_invalidated');
  });

  it('stays open at tier 4 (eligible) with no break flag', () => {
    const card = cleanCard();
    const s = stepPosition(initPosition(card), bar({ h: 101, l: 99, c: 100 }), card.exit, {
      regime_tier: 4,
    });
    expect(s.status).toBe('open');
  });
});

describe('conflict resolution', () => {
  it('a bar that spans BOTH target and stop resolves to stopped (worst case)', () => {
    const card = cleanCard();
    const s = stepPosition(initPosition(card), bar({ o: 100, h: 106, l: 97, c: 101 }), card.exit);
    expect(s.status).toBe('stopped');
    expect(s.realised_r).toBeCloseTo(-1);
  });
});

describe('terminal state', () => {
  it('an already-closed state is returned unchanged on further steps', () => {
    const card = cleanCard();
    const closed = stepPosition(initPosition(card), bar({ h: 101, l: 97, c: 97 }), card.exit);
    expect(closed.status).toBe('stopped');

    const again = stepPosition(closed, bar({ h: 200, l: 1, c: 150 }), card.exit);
    expect(again).toBe(closed); // same reference, no work done
    expect(again.bars_held).toBe(closed.bars_held);
    expect(again.realised_r).toBe(closed.realised_r);
  });
});

describe('MFE / MAE tracking', () => {
  it('tracks the favorable and adverse price extremes for a long', () => {
    // Wide stop/target + unreachable trail so nothing closes; pure excursion test.
    const exit: ExitPlan = {
      stop_price: 90,
      target_price: 130,
      trail_activate_r: 10,
      time_stop_days: 100,
      thesis_invalidation: [],
    };
    const card = cleanCard({ entry_price: 100, exit });
    const bars: Bar[] = [
      bar({ o: 100, h: 105, l: 98, c: 102 }),
      bar({ o: 102, h: 108, l: 101, c: 107 }),
      bar({ o: 107, h: 106, l: 103, c: 104 }),
    ];
    const s = runToCompletion(card, bars, exit);
    expect(s.status).toBe('open');
    expect(s.max_favorable_excursion).toBe(108); // highest high
    expect(s.max_adverse_excursion).toBe(98); // lowest low
    expect(s.bars_held).toBe(3);
  });

  it('does not mutate the input state', () => {
    const card = cleanCard();
    const before = initPosition(card);
    const snapshot: PositionState = { ...before };
    stepPosition(before, bar({ h: 106, l: 99, c: 105 }), card.exit);
    expect(before).toEqual(snapshot); // untouched
  });
});

describe('runToCompletion folding', () => {
  it('folds a full series and stops early once closed', () => {
    const card = cleanCard();
    const bars: Bar[] = [
      bar({ o: 100, h: 101, l: 99, c: 100 }), // nothing
      bar({ o: 100, h: 106, l: 99, c: 105 }), // target hit here
      bar({ o: 105, h: 110, l: 104, c: 108 }), // must NOT be processed
    ];
    const s = runToCompletion(card, bars, card.exit);
    expect(s.status).toBe('target_hit');
    expect(s.bars_held).toBe(2); // stopped early; bar 3 never folded
    expect(s.exit_bar_time).toBe(bars[1].t);
    expect(s.realised_r).toBeCloseTo(2.5);
  });

  it('honors per-bar signals aligned to bars', () => {
    const card = cleanCard();
    const bars: Bar[] = [
      bar({ o: 100, h: 101, l: 99, c: 100 }),
      bar({ o: 100, h: 101, l: 99, c: 100 }),
    ];
    const s = runToCompletion(card, bars, card.exit, [{}, { thesis_broken: true }]);
    expect(s.status).toBe('thesis_invalidated');
    expect(s.bars_held).toBe(2);
  });
});
