'use strict';

/**
 * LI (light–current) sweep: steps the laser current on a fixed clock so a
 * single power-meter recording captures the whole curve.
 *
 *   t = 0          lC<start>, lO1   (current set first, then output on)
 *   t = hold       lC<start+step>
 *   ...
 *   t = n * hold   lO0, lC<start>   (output off after the last hold, then the
 *                                    setpoint is parked back at the start so
 *                                    the next manual "On" does not fire at the
 *                                    top current)
 *
 * Every step is scheduled against the sweep's own start time rather than the
 * previous timer firing, so late timers never accumulate into drift.
 *
 * The clock is injectable so the sequence can be tested without waiting.
 */
class LISweep {
  /**
   * Current levels for a sweep, in hundredths of an amp (the board's units).
   * @returns {number[]}
   */
  static plan({ startA, endA, stepA }) {
    const start = Number(startA);
    const end = Number(endA);
    const step = Number(stepA);
    if (![start, end, step].every(Number.isFinite)) throw new Error('Enter numbers for start, end and step.');
    if (start < 0) throw new Error('Start current cannot be negative.');
    if (step <= 0) throw new Error('Step must be greater than zero.');
    if (end < start) throw new Error('End current must be at or above the start current.');

    const steps = Math.round((end - start) / step);
    if (Math.abs(start + steps * step - end) > step * 0.01) {
      throw new Error('End current must be a whole number of steps above the start current.');
    }
    if (steps + 1 > 500) throw new Error('That sweep has too many steps (500 maximum).');

    const levels = [];
    for (let i = 0; i <= steps; i += 1) levels.push(Math.round((start + i * step) * 100));
    return levels;
  }

  /**
   * @param {object} options
   * @param {object} options.safr    a connected SAFR instance
   * @param {number} options.startA
   * @param {number} options.endA
   * @param {number} options.stepA
   * @param {number} options.holdS   seconds at each current
   * @param {(info: object) => void} [options.onStep] after each current change
   * @param {(info: object) => void} [options.onDone] once, on finish or abort
   * @param {object} [options.clock] { now(): ms, setTimeout, clearTimeout }
   */
  constructor({ safr, startA = 0.5, endA = 2.0, stepA = 0.1, holdS = 10, onStep, onDone, clock } = {}) {
    if (!safr) throw new Error('LISweep needs a SAFR instance.');
    const hold = Number(holdS);
    if (!Number.isFinite(hold) || hold <= 0) throw new Error('Hold time must be greater than zero.');

    this.safr = safr;
    this.levels = LISweep.plan({ startA, endA, stepA });
    this.holdMs = hold * 1000;
    this.onStep = onStep || (() => {});
    this.onDone = onDone || (() => {});
    this.clock = clock || {
      now: () => performance.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id)
    };

    this.running = false;
    this.index = -1;
    this.t0 = 0;
    this.timer = null;
  }

  get total() {
    return this.levels.length;
  }

  /** Whole-sweep duration in seconds. */
  get durationS() {
    return (this.levels.length * this.holdMs) / 1000;
  }

  start() {
    if (this.running) throw new Error('Sweep already running.');
    if (!this.safr.isOpen) throw new Error('Not connected.');
    this.running = true;
    this.t0 = this.clock.now();
    this.#runStep(0);
  }

  /**
   * Stop early. Turns the output off unless `send` is false (used when the
   * link is already gone).
   * @returns {boolean} true if a running sweep was stopped
   */
  abort(reason = 'Sweep stopped.', { send = true } = {}) {
    if (!this.running) return false;
    this.running = false;
    if (this.timer !== null) {
      this.clock.clearTimeout(this.timer);
      this.timer = null;
    }
    if (send && this.safr.isOpen) {
      this.safr.laserOutputOff();
      this.safr.setLaserCurrent(this.levels[0]);
    }
    this.onDone({ completed: false, reason, index: this.index, total: this.total });
    return true;
  }

  /** Snapshot for the progress readout. */
  status() {
    const elapsed = this.running ? this.clock.now() - this.t0 : 0;
    const stepEnd = (this.index + 1) * this.holdMs;
    return {
      running: this.running,
      index: this.index,
      total: this.total,
      amps: this.index >= 0 ? this.levels[this.index] / 100 : null,
      stepRemainingS: Math.max(0, (stepEnd - elapsed) / 1000),
      totalRemainingS: Math.max(0, (this.total * this.holdMs - elapsed) / 1000)
    };
  }

  #schedule(fn, atMs) {
    const delay = Math.max(0, this.t0 + atMs - this.clock.now());
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      fn();
    }, delay);
  }

  #runStep(k) {
    if (!this.running) return;
    if (!this.safr.isOpen) {
      this.abort('Connection lost during the sweep.', { send: false });
      return;
    }
    if (k >= this.levels.length) {
      this.#finish();
      return;
    }

    this.index = k;
    this.safr.setLaserCurrent(this.levels[k]);
    if (k === 0) this.safr.laserOutputOn();
    this.onStep({ index: k, total: this.total, amps: this.levels[k] / 100 });
    this.#schedule(() => this.#runStep(k + 1), (k + 1) * this.holdMs);
  }

  #finish() {
    this.running = false;
    this.safr.laserOutputOff();
    this.safr.setLaserCurrent(this.levels[0]);
    this.onDone({ completed: true, index: this.index, total: this.total });
  }
}

window.LISweep = LISweep;
