import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROXIMATION,
  replayLuxAlgoBearishOrderBlocks,
  replayLuxAlgoBullishOrderBlocks,
} from './luxalgo-ob.mjs';

function bullishBreakFixture(length) {
  const candles = [{
    time: 0, open: 5, high: 7, low: 3, close: 5,
  }];
  for (let i = 1; i <= length; i += 1) {
    candles.push({
      time: i, open: 7, high: 8, low: 6, close: 7,
    });
  }
  candles.push({
    time: length + 1,
    open: 9,
    high: 10,
    low: 6,
    close: 9,
  });
  for (let i = 1; i <= length; i += 1) {
    candles.push({
      time: length + 1 + i,
      open: 7, high: 8, low: 6, close: 8,
    });
  }
  candles.push({
    time: 2 * length + 2, open: 8, high: 9, low: 6, close: 9,
  });
  candles.push({
    time: 2 * length + 3, open: 9, high: 11, low: 6, close: 10.5,
  });
  candles.push({
    time: 2 * length + 4, open: 10, high: 11, low: 6, close: 10.5,
  });
  return candles;
}

function bullishBreakWithPriorSwing() {
  const candles = [{ time: 0, open: 5, high: 7, low: 3, close: 5 }];
  for (let time = 1; time <= 10; time += 1) {
    candles.push({ time, open: 7, high: 8, low: 6, close: 7 });
  }
  candles.push({ time: 11, open: 8, high: 9, low: 6, close: 8 });
  for (let time = 12; time <= 21; time += 1) {
    candles.push({ time, open: 7, high: 8, low: 6, close: 7 });
  }
  candles.push({ time: 22, open: 6, high: 7, low: 4, close: 6 });
  for (let time = 23; time <= 27; time += 1) {
    candles.push({ time, open: 7, high: 8, low: 6, close: 7 });
  }
  candles.push({ time: 28, open: 9, high: 10, low: 6, close: 9 });
  for (let time = 29; time <= 33; time += 1) {
    candles.push({ time, open: 7, high: 8, low: 6, close: 8 });
  }
  candles.push({ time: 34, open: 8, high: 9, low: 6, close: 9 });
  candles.push({ time: 35, open: 9, high: 11, low: 6, close: 10.5 });
  candles.push({ time: 36, open: 10, high: 11, low: 6, close: 10.5 });
  return candles;
}

function bearishBreakWithPriorSwing() {
  const candles = [{ time: 0, open: 5, high: 7, low: 4, close: 5 }];
  for (let time = 1; time <= 10; time += 1) {
    candles.push({ time, open: 7, high: 8, low: 6, close: 7 });
  }
  candles.push({ time: 11, open: 8, high: 9, low: 6, close: 8 });
  for (let time = 12; time <= 21; time += 1) {
    candles.push({ time, open: 7, high: 8, low: 6, close: 7 });
  }
  candles.push({ time: 22, open: 6, high: 7, low: 3, close: 6 });
  for (let time = 23; time <= 27; time += 1) {
    candles.push({ time, open: 7, high: 8, low: 6, close: 7 });
  }
  candles.push({ time: 28, open: 6, high: 8, low: 4, close: 4 });
  candles.push({ time: 29, open: 4, high: 5, low: 2, close: 2.5 });
  candles.push({ time: 30, open: 3, high: 5, low: 2.5, close: 3 });
  return candles;
}

test('creates internal OB only after confirmed bullish structure break', () => {
  const bars = bullishBreakWithPriorSwing();
  const rows = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    swingLength: 10,
  });
  const breakIndex = 35;
  assert.deepEqual(rows[breakIndex].zones, []);
  assert.equal(rows[breakIndex + 1].zones.length, 1);
  assert.deepEqual(rows[breakIndex + 1].zones[0], {
    high: 10,
    low: 6,
    kind: 'internal',
    createdAt: 28,
    detectedAt: 35,
  });
});

test('high/low mitigation removes an active zone strictly below its low', () => {
  const bars = bullishBreakWithPriorSwing();
  bars.push({
    time: 37,
    open: 10,
    high: 11,
    low: 6,
    close: 10,
  });
  const mitigationTime = bars.at(-1).time;
  bars.push({
    time: mitigationTime + 1,
    open: 5,
    high: 6,
    low: 5,
    close: 5,
  });
  const rows = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    swingLength: 10,
  });
  assert.equal(rows.at(-2).zones.length, 1);
  assert.equal(rows.at(-1).zones.length, 1);
  bars.push({
    time: mitigationTime + 2,
    open: 5,
    high: 6,
    low: 5,
    close: 5,
  });
  const after = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    swingLength: 10,
  });
  assert.deepEqual(after.at(-1).zones, []);
});

test('close mitigation preserves a zone on a wick through its low', () => {
  const bars = bullishBreakWithPriorSwing();
  bars.push({ time: 37, open: 10, high: 11, low: 6, close: 10 });
  const time = bars.at(-1).time + 1;
  bars.push({
    time, open: 7, high: 8, low: 5, close: 6,
  });
  const highLow = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    swingLength: 10,
  });
  const closeOnly = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    swingLength: 10,
    mitigation: 'close',
  });
  assert.equal(highLow.at(-1).zones.length, 1);
  bars.push({ time: time + 1, open: 7, high: 8, low: 6, close: 7 });
  const afterHighLow = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    swingLength: 10,
  });
  const afterCloseOnly = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    swingLength: 10,
    mitigation: 'close',
  });
  assert.deepEqual(afterHighLow.at(-1).zones, []);
  assert.equal(afterCloseOnly.at(-1).zones.length, 1);
});

test('internal OB is suppressed when its pivot equals current swing high', () => {
  const bars = bullishBreakFixture(5);
  const internalOnly = replayLuxAlgoBullishOrderBlocks(bars, {
    kinds: ['internal'],
    internalLength: 5,
    swingLength: 5,
  });
  assert.ok(internalOnly.every((row) => row.zones.length === 0));
});

test('creates bearish internal OB from parsed-high extremum after bearish break', () => {
  const bars = bearishBreakWithPriorSwing();
  const rows = replayLuxAlgoBearishOrderBlocks(bars, {
    kinds: ['internal'],
    internalLength: 5,
    swingLength: 10,
  });
  assert.deepEqual(rows[29].zones, []);
  assert.deepEqual(rows[30].zones[0], {
    high: 8,
    low: 6,
    kind: 'internal',
    createdAt: 23,
    detectedAt: 29,
  });
});

test('bearish OB is removed only after high mitigation crosses its high', () => {
  const bars = bearishBreakWithPriorSwing();
  bars.push({ time: 31, open: 8, high: 8, low: 7, close: 7.5 });
  const afterBreak = replayLuxAlgoBearishOrderBlocks(bars, {
    kinds: ['internal'],
    internalLength: 5,
    swingLength: 10,
  });
  assert.equal(afterBreak.at(-1).zones.length, 1);
  bars.push({ time: 32, open: 8, high: 9, low: 7, close: 8.5 });
  bars.push({ time: 33, open: 8, high: 8, low: 7, close: 7.5 });
  const afterMitigation = replayLuxAlgoBearishOrderBlocks(bars, {
    kinds: ['internal'],
    internalLength: 5,
    swingLength: 10,
  });
  assert.equal(afterMitigation.at(-2).zones.length, 1);
  assert.deepEqual(afterMitigation.at(-1).zones, []);
});

test('internal bearish OB is suppressed when its pivot equals current swing low', () => {
  const bars = bearishBreakWithPriorSwing();
  const internalOnly = replayLuxAlgoBearishOrderBlocks(bars, {
    kinds: ['internal'],
    internalLength: 5,
    swingLength: 5,
  });
  assert.ok(internalOnly.every((row) => row.zones.length === 0));
});

test('replays swing pivots at requested size and exposes approximation', () => {
  const rows = replayLuxAlgoBullishOrderBlocks(bullishBreakFixture(50), {
    kinds: ['swing'],
  });
  assert.equal(rows[103].zones.length, 0);
  assert.equal(rows[104].zones[0].kind, 'swing');
  assert.match(APPROXIMATION, /approximation/i);
});

test('rejects out-of-order candles', () => {
  assert.throws(() => replayLuxAlgoBullishOrderBlocks([
    { time: 2, open: 1, high: 2, low: 0, close: 1 },
    { time: 1, open: 1, high: 2, low: 0, close: 1 },
  ]), /strictly chronological/);
});