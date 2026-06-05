/**
 * Local call progress tones (ringback / ring) via Web Audio — no bundled sound files.
 */
class CallTonePlayer {
  constructor() {
    /** @type {AudioContext | null} */
    this.ctx = null;
    /** @type {GainNode | null} */
    this.masterGain = null;
    /** @type {{ osc: OscillatorNode; gain: GainNode }[]} */
    this.oscillators = [];
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.patternTimer = null;
    /** @type {'ringback' | 'ringing' | 'busy' | null} */
    this.mode = null;
    /** @type {number} */
    this._toneLevel = 0.22;
  }

  _ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0;
      this.masterGain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async _resumeContext() {
    const ctx = this._ensureContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  /**
   * Call once from a user gesture (login) so later tones are not blocked by autoplay policy.
   */
  async warmup() {
    if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') {
      return;
    }
    await this._resumeContext();
  }

  _stopOscillators() {
    for (const { osc } of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // Already stopped.
      }
    }
    this.oscillators = [];
  }

  _clearPattern() {
    if (this.patternTimer !== null) {
      clearTimeout(this.patternTimer);
      this.patternTimer = null;
    }
  }

  _setLevel(level) {
    if (!this.masterGain || !this.ctx) {
      return;
    }
    this.masterGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.015);
  }

  /**
   * @param {number[]} frequencies
   * @param {number} level
   */
  _startDualTone(frequencies, level) {
    const ctx = this._ensureContext();
    this._stopOscillators();

    const perOsc = level / frequencies.length;
    for (const frequency of frequencies) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = frequency;

      const gain = ctx.createGain();
      gain.gain.value = perOsc;
      osc.connect(gain);
      gain.connect(this.masterGain);

      osc.start();
      this.oscillators.push({ osc, gain });
    }
  }

  /**
   * Alternating on/off segments in ms: [on, off, on, off, …]
   * @param {number[]} segmentsMs
   */
  _runSequence(segmentsMs) {
    this._clearPattern();
    let index = 0;

    const tick = () => {
      if (!this.mode) {
        return;
      }

      const audible = index % 2 === 0;
      this._setLevel(audible ? this._toneLevel : 0);
      const delay = segmentsMs[index];
      index = (index + 1) % segmentsMs.length;
      this.patternTimer = setTimeout(tick, delay);
    };

    tick();
  }

  stop() {
    this.mode = null;
    this._clearPattern();
    this._setLevel(0);
    this._stopOscillators();
  }

  /**
   * Analog-style ringback: tuu… (pause) tuu… (long pause) — UK/common PBX pattern.
   */
  async startRingback() {
    if (this.mode === 'ringback') {
      return;
    }

    this.stop();
    await this._resumeContext();
    this.mode = 'ringback';
    this._toneLevel = 0.2;
    this._startDualTone([440, 480], this._toneLevel);
    // 0.5s tone, 0.25s gap, 0.5s tone, 2.5s silence → "tuu… | tuu… |"
    this._runSequence([500, 250, 500, 2500]);
  }

  /** Desk-phone ring: ~2s burst, ~4s silence. */
  async startRinging() {
    if (this.mode === 'ringing') {
      return;
    }

    this.stop();
    await this._resumeContext();
    this.mode = 'ringing';
    this._toneLevel = 0.28;
    this._startDualTone([440, 480], this._toneLevel);
    this._runSequence([2000, 4000]);
  }

  /**
   * Busy / congestion cadence: tu… tu… tu… (internal extension reject, no carrier SDP).
   */
  async startBusy() {
    if (this.mode === 'busy') {
      return;
    }

    this.stop();
    await this._resumeContext();
    this.mode = 'busy';
    this._toneLevel = 0.24;
    this._startDualTone([480, 620], this._toneLevel);
    this._runSequence([400, 400]);
  }

  /**
   * @param {'busy' | 'ringback' | 'ringing'} mode
   */
  async play(mode) {
    switch (mode) {
      case 'busy':
        return this.startBusy();
      case 'ringback':
        return this.startRingback();
      case 'ringing':
        return this.startRinging();
      default:
        return;
    }
  }
}

export const callTonePlayer = new CallTonePlayer();
export default callTonePlayer;
