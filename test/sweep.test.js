'use strict';

/**
 * LI sweep tests. A fake clock and a fake board stand in for timers and the
 * serial link, so a 160 s sweep runs instantly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

globalThis.window = globalThis.window || {};
require(path.join(__dirname, '..', 'src', 'renderer', 'sweep.js'));
const { LISweep } = window;

/** Manual clock: timers fire only when advance() passes their due time. */
class FakeClock {
  constructor() {
    this.t = 0;
    this.timers = [];
    this.nextId = 1;
    this.lateMs = 0; // extra delay added to every timer, to test drift
  }

  now() {
    return this.t;
  }

  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.timers.push({ id, at: this.t + ms + this.lateMs, fn });
    return id;
  }

  clearTimeout(id) {
    this.timers = this.timers.filter((tm) => tm.id !== id);
  }

  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

/** Records commands with the clock time they were sent. */
function makeBoard(clock) {
  const log = [];
  const board = {
    isOpen: true,
    setLaserCurrent: (h) => log.push([clock.now(), `lC${h}`]),
    laserOutputOn: () => log.push([clock.now(), 'lO1']),
    laserOutputOff: () => log.push([clock.now(), 'lO0'])
  };
  return { board, log };
}

function makeSweep(overrides = {}) {
  const clock = new FakeClock();
  const { board, log } = makeBoard(clock);
  const done = [];
  const sweep = new LISweep({
    safr: board,
    startA: 0.5,
    endA: 2.0,
    stepA: 0.1,
    holdS: 10,
    clock,
    onDone: (info) => done.push(info),
    ...overrides
  });
  return { sweep, clock, board, log, done };
}

test('plan: 0.5 to 2.0 A in 0.1 A steps is 16 levels in hundredths', () => {
  const levels = LISweep.plan({ startA: 0.5, endA: 2.0, stepA: 0.1 });
  assert.equal(levels.length, 16);
  assert.deepEqual(levels, [50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]);
});

test('plan rejects an end that is not a whole number of steps away', () => {
  assert.throws(() => LISweep.plan({ startA: 0.5, endA: 2.05, stepA: 0.1 }), /whole number of steps/);
  assert.throws(() => LISweep.plan({ startA: 1, endA: 0.5, stepA: 0.1 }), /at or above/);
  assert.throws(() => LISweep.plan({ startA: 0.5, endA: 2, stepA: 0 }), /greater than zero/);
});

test('full sweep: sets current before turning on, steps every 10 s, turns off after the last hold', () => {
  const { sweep, clock, log, done } = makeSweep();
  sweep.start();
  clock.advance(200000);

  // start: current first, then output on, both at t = 0
  assert.deepEqual(log[0], [0, 'lC50']);
  assert.deepEqual(log[1], [0, 'lO1']);

  // each following level exactly one hold later
  const steps = log.filter(([, c]) => c.startsWith('lC')).slice(0, 16);
  steps.forEach(([t, c], i) => {
    assert.equal(t, i * 10000);
    assert.equal(c, `lC${50 + i * 10}`);
  });

  // after the 10 s hold at 2.00 A: off, then setpoint parked back at the start
  const tail = log.slice(-2);
  assert.deepEqual(tail, [[160000, 'lO0'], [160000, 'lC50']]);
  assert.equal(log.filter(([, c]) => c === 'lO1').length, 1);
  assert.deepEqual(done, [{ completed: true, index: 15, total: 16 }]);
  assert.equal(sweep.running, false);
});

test('late timers do not accumulate drift', () => {
  const { sweep, clock, log } = makeSweep();
  clock.lateMs = 40; // every timer fires 40 ms late
  sweep.start();
  clock.advance(200000);

  const steps = log.filter(([, c]) => c.startsWith('lC')).slice(0, 16);
  steps.forEach(([t], i) => {
    if (i === 0) return;
    // each step is at most one timer's lateness behind the ideal grid
    assert.ok(t - i * 10000 <= 40, `step ${i} at ${t} ms`);
  });
});

test('abort turns the laser off immediately and stops stepping', () => {
  const { sweep, clock, log, done } = makeSweep();
  sweep.start();
  clock.advance(35000); // during the 4th step (0.80 A)
  assert.equal(sweep.status().amps, 0.8);

  assert.equal(sweep.abort('stopped'), true);
  const after = log.length;
  assert.deepEqual(log.slice(-2), [[35000, 'lO0'], [35000, 'lC50']]);

  clock.advance(200000);
  assert.equal(log.length, after, 'no commands after abort');
  assert.equal(done[0].completed, false);
  assert.equal(sweep.abort('again'), false);
});

test('a lost connection stops the sweep without trying to send', () => {
  const { sweep, clock, board, log, done } = makeSweep();
  sweep.start();
  clock.advance(15000);
  board.isOpen = false;
  const before = log.length;
  clock.advance(10000);
  assert.equal(log.length, before);
  assert.equal(done[0].completed, false);
  assert.match(done[0].reason, /Connection lost/);
});

test('status reports the step and time remaining', () => {
  const { sweep, clock } = makeSweep();
  sweep.start();
  clock.advance(23500);
  const st = sweep.status();
  assert.equal(st.index, 2);
  assert.equal(st.amps, 0.7);
  assert.equal(Math.round(st.stepRemainingS * 10) / 10, 6.5);
  assert.equal(Math.round(st.totalRemainingS * 10) / 10, 136.5);
  assert.equal(sweep.durationS, 160);
});
