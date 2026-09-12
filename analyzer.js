// analyzer.js — on-device engine log diagnosis.
//
// Ported from the Car Doctor Kotlin pipeline, which is now retired: this file
// is the only copy. The shape is unchanged, and so are the guarantees:
//
//   CSV ─▶ 1 Ingest ─▶ 2 Condition ─▶ 3 Segment ─▶ 4 Aggregate ─▶ 5 Detect ─▶ 6 Rank
//          (stream)     (validity)     (states)     (fixed size)   (declarative) (root cause)
//
// Nothing between the text and the summary retains history: the reader holds
// one row, the resampler one time slot, the segmenter a one-second window, and
// the summary a fixed set of cells. A ten-minute log and a six-hour log produce
// a summary of the same size, so analysis cost is set by the number of analysis
// cells rather than the length of the drive.
//
// Runs in the browser (window.CarDoctor), in the Capacitor app, and under node
// for the test suite. No dependencies, no network: a log never leaves the phone.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.CarDoctor = api;
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ══════════════════════════════════════════════════════════════════════
    // 0. Schema
    // ══════════════════════════════════════════════════════════════════════

    /** How several raw samples inside one resample slot are combined into one value. */
    const MEAN = 'MEAN';
    /**
     * Keep the most negative. Right where the extreme *is* the measurement
     * rather than an outlier to be smoothed away — averaging a knock correction
     * of -5.62 with its neighbours reports -5.44 and quietly understates how
     * hard the engine was knocking.
     */
    const PEAK_NEGATIVE = 'PEAK_NEGATIVE';

    /**
     * Canonical channel vocabulary.
     *
     * Every logger names things differently ("engine speed (RPM)", "RPM",
     * "Engine Speed"). The whole pipeline speaks Channel and nothing else;
     * alias resolution happens once, at the file boundary, so adding support
     * for a new logger format never touches a detector.
     *
     * plausibleMin/plausibleMax are physical sanity bounds, not fault
     * thresholds. They exist so the conditioning stage can tell "this sensor is
     * reporting nonsense" from "this engine has a problem".
     */
    const CHANNEL_DEFS = [
        ['RPM', 'Engine speed', 'rpm', 0, 12000, ['engine speed', 'rpm', 'engine rpm', 'revs']],
        ['ENGINE_LOAD', 'Engine load', 'mg/str', 0, 3000, ['engine load', 'load', 'cylinder charge', 'mass per stroke']],
        ['MAF', 'Mass airflow', 'kg/h', 0, 1500, ['mass airflow', 'maf', 'air mass', 'airflow']],
        ['TPS', 'Throttle position', '%', 0, 100, ['tps', 'throttle', 'throttle position', 'pedal position']],
        ['IGNITION_ADVANCE', 'Ignition advance', 'degCRK', -40, 60, ['ignition angle', 'ignition advance', 'ignition timing', 'spark advance', 'timing advance', 'ign', 'ignition total timing', 'total timing']],
        ['INJECTOR_PULSE', 'Injector pulse width', 'ms', 0, 40, ['fuel inj', 'injector pulse', 'injection time', 'pulse width', 'inj time', 'ipw', 'injector pulse width']],
        ['INTAKE_AIR_TEMP', 'Intake air temp', 'degC', -50, 150, ['intake air temp', 'iat', 'air temp', 'charge temp', 'inlet air temp']],
        ['COOLANT_TEMP', 'Coolant temp', 'degC', -50, 160, ['coolant temp', 'ect', 'water temp', 'engine temp', 'coolant temperature']],
        ['RADIATOR_TEMP', 'Radiator temp', 'degC', -50, 160, ['radiator temp', 'rad temp']],
        ['OIL_TEMP', 'Oil temp', 'degC', -50, 200, ['oil temp', 'oil temperature']],
        ['VEHICLE_SPEED', 'Vehicle speed', 'km/h', 0, 400, ['speed', 'vehicle speed', 'vss', 'road speed', 'vs']],
        ['IACV', 'Idle air control', '%', -30, 110, ['iacv alphan', 'iacv position', 'iacv', 'iac', 'idle air control', 'idle valve']],
        ['LAMBDA_INT_1', 'Fuel trim bank 1', '%', -50, 50, ['lambda int 1', 'lambda integrator 1', 'short term fuel trim 1', 'stft 1', 'trim 1', 'lambda 1', 'a f correction 1']],
        ['LAMBDA_INT_2', 'Fuel trim bank 2', '%', -50, 50, ['lambda int 2', 'lambda integrator 2', 'short term fuel trim 2', 'stft 2', 'trim 2', 'lambda 2', 'a f correction 2']],
        // Timing the ECU has pulled in response to detected knock. Conventionally
        // negative or zero: zero means no knock, -4 means four degrees removed.
        // This is a direct measurement of the thing IGNITION_ADVANCE can only be
        // used to infer, so when a log carries it the inferred detector stands down.
        ['KNOCK_CORRECTION', 'Knock correction', 'degCRK', -30, 10, ['knock correction', 'knock cor', 'feedback knock correction', 'knock', 'knock retard', 'fine knock learn', 'knock sum'], PEAK_NEGATIVE],
        ['CAM_ADVANCE', 'Cam advance', 'deg', -30, 90, ['cam advance', 'intake cam advance', 'vanos', 'avcs', 'vvt', 'cam angle', 'intake cam']],
        ['BATTERY_VOLTAGE', 'Battery voltage', 'V', 0, 20, ['battery voltage', 'batt v', 'vbat']],
        ['SYSTEM_VOLTAGE', 'System voltage', 'V', 0, 20, ['input v', 'system voltage', 'supply voltage', 'ecu voltage']],
        ['FUEL_RATE', 'Fuel rate', 'l/h', 0, 100, ['fuel usage', 'fuel rate', 'fuel flow']],
        ['ACCEL_X', 'Accel X', 'g', -5, 5, ['accel x', 'acceleration x', 'g x']],
        ['ACCEL_Y', 'Accel Y', 'g', -5, 5, ['accel y', 'acceleration y', 'g y']],
        ['ACCEL_Z', 'Accel Z', 'g', -5, 5, ['accel z', 'acceleration z', 'g z']],
        // Derived, never read from a file: short-window standard deviation of
        // engine speed. It carries no aliases, so resolve() can never match a
        // header to it. Computing roughness in the time domain and then
        // aggregating it — rather than taking the spread of engine speed over a
        // whole cell — is what separates genuine hunting from ordinary drift.
        ['RPM_ROUGHNESS', 'Engine speed roughness', 'rpm', 0, 2000, []],
    ];

    const CHANNELS = CHANNEL_DEFS.map(([name, displayName, unit, lo, hi, aliases, mode], ordinal) => ({
        ordinal, name, displayName, unit,
        plausibleMin: lo, plausibleMax: hi,
        aliases, resampleMode: mode || MEAN,
    }));

    /** Channels by name, so rules read `CH.RPM` rather than an index. */
    const CH = {};
    for (const c of CHANNELS) CH[c.name] = c;

    /**
     * Reduces a header cell to a comparison key: drops the unit suffix in
     * parentheses and every non-alphanumeric character, so "Engine Speed (RPM)",
     * "engine_speed" and "ENGINESPEED" all collapse to the same token.
     */
    function normalizeHeader(header) {
        return String(header).toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]/g, '');
    }

    // First alias registered wins, so a channel's own preferred spelling is
    // never stolen by a later channel that lists the same loose alias.
    const CHANNEL_BY_KEY = new Map();
    for (const channel of CHANNELS) {
        for (const alias of channel.aliases) {
            const key = normalizeHeader(alias);
            if (!CHANNEL_BY_KEY.has(key)) CHANNEL_BY_KEY.set(key, channel);
        }
    }

    function resolveChannel(header) {
        return CHANNEL_BY_KEY.get(normalizeHeader(header)) || null;
    }

    /**
     * How good a match this header is for the channel it resolves to: 0 is the
     * channel's preferred spelling, higher is a looser synonym. Null when it
     * matches nothing.
     *
     * Alias order is preference order, which matters when one log carries
     * several columns for the same concept. A RomRaider log has both `IACV` — a
     * correction that swings negative — and `IACV_AlphaN`, the actual valve
     * position. Only the position can answer "is the idle valve saturated", so
     * it is listed first and wins.
     */
    function aliasRank(header) {
        const channel = resolveChannel(header);
        if (!channel) return null;
        const key = normalizeHeader(header);
        const rank = channel.aliases.findIndex(a => normalizeHeader(a) === key);
        return rank >= 0 ? rank : null;
    }

    /**
     * One time-aligned observation of every channel.
     *
     * Values live in a Float64Array indexed by channel ordinal, with NaN
     * meaning "not present in this log". A dense typed array rather than an
     * object keeps the hot streaming path allocation-light on a phone.
     */
    function emptyValues() {
        return new Float64Array(CHANNELS.length).fill(NaN);
    }

    class Sample {
        constructor(timeMs, values) {
            this.timeMs = timeMs;
            this.values = values;
        }
        get(channel) { return this.values[channel.ordinal]; }
        has(channel) { return !Number.isNaN(this.values[channel.ordinal]); }
    }

    /**
     * Per-vehicle calibration.
     *
     * Nothing in the detector set hardcodes a threshold. Absolute load in
     * mg/str in particular is meaningless across engines — 400 mg/str is a hard
     * pull on a small NA four and cruise on a big turbo six — so anything
     * engine-specific lives here and ships as a named profile.
     */
    const DEFAULT_PROFILE = {
        name: 'Generic',

        // --- Operating state boundaries ---
        /** Below this the engine is not running (cranking or off). */
        runningRpmMin: 400,
        /** Coolant below this means the engine is still warming up. */
        warmCoolantC: 80,
        /** Coolant a healthy thermostat should reach and hold. */
        thermostatTargetC: 85,
        idleRpmMax: 1200,
        /**
         * How far above its learned closed-throttle reading the throttle may sit
         * and still count as closed. The reference itself is learned per log
         * rather than assumed to be zero, because it is not: one reference log
         * reads 0.0% with the throttle plainly open, another reads 14.1% with it
         * shut. Either hardcoded assumption silently destroys idle and overrun
         * detection on the other.
         */
        closedThrottleBandPct: 1.5,
        idleSpeedMaxKph: 3,
        /** Throttle at or above this counts as a full-load pull. */
        wotTpsPct: 60,
        /** Load at or above this counts as high load even if TPS is not reported. */
        highLoadThreshold: 400,
        /** Throttle moving faster than this makes the sample a transient. */
        steadyTpsRatePctPerSec: 3,
        /** Engine speed changing faster than this makes the sample a transient. */
        steadyRpmRatePerSec: 400,
        /**
         * Load changing faster than this makes the sample a transient. Exists
         * because throttle position cannot be trusted as the sole transient
         * signal: many factory sensors have a dead zone at small openings and
         * read a flat zero over a wide range of real pedal travel.
         */
        steadyLoadRatePerSec: 250,
        /**
         * Load at or below this is genuine closed-throttle overrun. A closed
         * throttle reading alone is not enough: on the reference log the
         * throttle channel reads zero for three quarters of all moving samples
         * while the engine is plainly making power.
         */
        overrunLoadMax: 80,

        // --- Fault thresholds ---
        overheatCoolantC: 110,
        overheatOilC: 130,
        /** Coolant-to-radiator delta above this when warm suggests restricted flow. */
        coolantRadiatorDeltaMaxC: 30,
        /** A fuel trim beyond this is a real correction, not noise. */
        trimSignificantPct: 8,
        /** A fuel trim beyond this is at or near the ECU's authority limit. */
        trimRailPct: 18,
        /** Sustained difference between banks that points at a single-bank fault. */
        bankImbalancePct: 6,
        chargingMinV: 13,
        chargingMaxV: 15.2,
        /** Ignition pulled by more than this, throttle still, reads as knock retard. */
        knockRetardDeg: 6,
        /** Knock correction at or beyond this (negative) is a real event, not dithering. */
        knockCorrectionDeg: -1,
        /** Knock correction at or beyond this is severe. */
        knockCorrectionSevereDeg: -4,
        /** Cam advance spanning less than this across a drive suggests a stuck cam. */
        camAdvanceMinSpanDeg: 5,
        /** Idle speed standard deviation above this is an unstable idle. */
        idleRpmStdevMax: 60,

        // --- Analysis resolution ---
        /**
         * Outside air temperature, when something actually knows it - a weather
         * lookup for where and when the drive happened. Null means infer it from
         * the log, which is a proxy rather than a measurement.
         */
        ambientC: null,

        resampleHz: 5,
        /** Minimum seconds a condition must hold before it can be reported at all. */
        minEvidenceSeconds: 20,
        /** Repeat detections inside this window collapse into a single occurrence. */
        eventDeadTimeSec: 3,
    };

    function makeProfile(overrides) {
        return Object.assign({}, DEFAULT_PROFILE, overrides || {});
    }

    function resampleIntervalMs(profile) {
        return Math.trunc(1000 / profile.resampleHz);
    }

    // ══════════════════════════════════════════════════════════════════════
    // 1. Ingest
    // ══════════════════════════════════════════════════════════════════════

    const ELAPSED_KEYS = new Set(['timestamp', 'time', 'timems', 'elapsed', 'elapsedms']);
    const DAY_MS = 24 * 60 * 60 * 1000;
    /** Tolerate small clock jitter without treating it as a midnight rollover. */
    const MIDNIGHT_BACKSTEP_MS = 60 * 60 * 1000;

    /** Minimal RFC-4180 splitter: handles quoted cells and doubled quotes. */
    function splitCsv(line) {
        const out = [];
        let cell = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const c = line[i];
            if (inQuotes && c === '"' && line[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') inQuotes = !inQuotes;
            else if (c === ',' && !inQuotes) { out.push(cell); cell = ''; }
            else cell += c;
        }
        out.push(cell);
        return out;
    }

    function parseNumber(cell) {
        if (cell === undefined) return null;
        const trimmed = cell.trim();
        if (trimmed === '') return null;
        const value = Number(trimmed);
        return Number.isFinite(value) ? value : null;
    }

    /**
     * Maps header cells onto canonical channels, and works out how a row's
     * timestamp is recovered.
     *
     * A column that loses to a better-matching column for the same channel is
     * recognised, just not used — so it is deliberately not reported as
     * unrecognised.
     */
    function buildHeader(columns, assumedIntervalMs) {
        const mapping = new Map();       // column index -> channel
        const bestRank = new Map();      // channel -> best alias rank seen
        const chosenColumn = new Map();  // channel -> winning column index
        const unmapped = [];
        let elapsedIndex = -1;
        let hour = -1, minute = -1, second = -1;

        columns.forEach((raw, index) => {
            if (!raw || raw.trim() === '') return;
            const key = normalizeHeader(raw);
            if (ELAPSED_KEYS.has(key)) { elapsedIndex = index; return; }
            if (key === 'hour') { hour = index; return; }
            if (key === 'minute') { minute = index; return; }
            if (key === 'second') { second = index; return; }
            if (key === 'date') return;

            const channel = resolveChannel(raw);
            if (!channel) { unmapped.push(raw); return; }

            const rank = aliasRank(raw);
            const rankValue = rank === null ? Number.MAX_SAFE_INTEGER : rank;
            const previous = bestRank.get(channel);
            if (previous === undefined || rankValue < previous) {
                if (chosenColumn.has(channel)) mapping.delete(chosenColumn.get(channel));
                mapping.set(index, channel);
                bestRank.set(channel, rankValue);
                chosenColumn.set(channel, index);
            }
        });

        let timeSource;
        if (elapsedIndex >= 0) timeSource = { kind: 'elapsed', columnIndex: elapsedIndex };
        else if (hour >= 0 && minute >= 0 && second >= 0) timeSource = { kind: 'clock', hour, minute, second };
        else timeSource = { kind: 'rowIndex', assumedIntervalMs };

        return { columns, mapping, unmapped, timeSource, channels: new Set(mapping.values()) };
    }

    /**
     * Streaming CSV reader.
     *
     * Walks the text a line at a time with indexOf rather than split('\n'), so
     * no array of every row is ever materialised: peak cost is one row
     * regardless of whether the log covers ten minutes or six hours.
     */
    function readCsv(text, onSample, options) {
        const assumedIntervalMs = (options && options.assumedIntervalMs) || 66;
        const onProgress = options && options.onProgress;

        const total = text.length;
        let cursor = 0;

        const nextLine = () => {
            if (cursor >= total) return null;
            let end = text.indexOf('\n', cursor);
            if (end === -1) end = total;
            let line = text.slice(cursor, end);
            cursor = end + 1;
            // Tolerate CRLF, which a Windows-side logger writes.
            if (line.endsWith('\r')) line = line.slice(0, -1);
            return line;
        };

        const headerLine = nextLine();
        if (headerLine === null) throw new Error('Log file is empty');
        const columns = splitCsv(headerLine).map(c => c.trim());
        const header = buildHeader(columns, assumedIntervalMs);

        let rows = 0, malformed = 0, rowIndex = 0;
        let first = null, last = 0;
        // Clock-part logs wrap at midnight; track that so a drive over 00:00
        // stays monotonic.
        let dayOffsetMs = 0;
        let previousClockMs = null;

        for (let line = nextLine(); line !== null; line = nextLine()) {
            if (line.trim() === '') continue;
            const cells = splitCsv(line);
            if (cells.length === 0 || cells[0].trim() === '') { malformed++; continue; }

            const values = emptyValues();
            for (const [index, channel] of header.mapping) {
                if (index >= cells.length) continue;
                const parsed = parseNumber(cells[index]);
                if (parsed !== null) values[channel.ordinal] = parsed;
            }

            let timeMs = null;
            const ts = header.timeSource;
            if (ts.kind === 'elapsed') {
                const raw = parseNumber(cells[ts.columnIndex]);
                if (raw !== null) timeMs = Math.trunc(raw);
            } else if (ts.kind === 'clock') {
                const h = parseNumber(cells[ts.hour]);
                const m = parseNumber(cells[ts.minute]);
                const s = parseNumber(cells[ts.second]);
                if (h !== null && m !== null && s !== null) {
                    const clock = ((Math.trunc(h) * 60 + Math.trunc(m)) * 60 + Math.trunc(s)) * 1000;
                    if (previousClockMs !== null && clock < previousClockMs - MIDNIGHT_BACKSTEP_MS) {
                        dayOffsetMs += DAY_MS;
                    }
                    previousClockMs = clock;
                    timeMs = clock + dayOffsetMs;
                }
            } else {
                timeMs = rowIndex * ts.assumedIntervalMs;
            }

            if (timeMs === null) { malformed++; continue; }

            if (first === null) first = timeMs;
            last = timeMs;
            rows++;
            rowIndex++;
            onSample(new Sample(timeMs, values));

            if (onProgress && rows % PROGRESS_INTERVAL_ROWS === 0 && total > 0) {
                onProgress(Math.min(1, Math.max(0, cursor / total)));
            }
        }

        const firstTimeMs = first === null ? 0 : first;
        return {
            header,
            rowsRead: rows,
            rowsMalformed: malformed,
            firstTimeMs,
            lastTimeMs: last,
            durationMs: Math.max(0, last - firstTimeMs),
        };
    }

    const PROGRESS_INTERVAL_ROWS = 2000;

    // ══════════════════════════════════════════════════════════════════════
    // 2. Condition
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Collapses an irregular log onto a uniform time grid.
     *
     * Two facts about real logs make this necessary. First, the nominal log
     * rate is not the data rate: in a 15 Hz log the engine speed may genuinely
     * update at 8 Hz and the coolant temperature at 0.1 Hz, so a channel is
     * held at its last known value until it actually changes. Second, sample
     * spacing wanders, and every downstream rate calculation would be wrong if
     * it assumed a fixed dt.
     *
     * Gaps longer than maxGapMs — the engine stopped, the logger paused — are
     * not filled. Emitting carried-forward samples across a ten minute gap
     * would invent an idle period that never happened.
     */
    class Resampler {
        constructor(intervalMs, maxGapMs = 2000) {
            this.intervalMs = intervalMs;
            this.maxGapMs = maxGapMs;
            const size = CHANNELS.length;
            this.sums = new Float64Array(size);
            this.counts = new Int32Array(size);
            this.extremes = new Float64Array(size).fill(NaN);
            this.lastKnown = new Float64Array(size).fill(NaN);
            this.slotStart = null;
            this.lastInputTime = null;
            this.pending = false;
        }

        push(sample, out) {
            if (this.slotStart === null) this.slotStart = sample.timeMs;

            // A long silence ends the current slot and restarts the grid on the
            // far side of the gap.
            if (this.lastInputTime !== null && sample.timeMs - this.lastInputTime > this.maxGapMs) {
                this.emit(out);
                this.reset();
                this.slotStart = sample.timeMs;
            }
            this.lastInputTime = sample.timeMs;

            while (sample.timeMs >= this.slotStart + this.intervalMs) {
                this.emit(out);
                this.slotStart += this.intervalMs;
                // Skip empty slots rather than emitting duplicates of the last value.
                if (sample.timeMs - this.slotStart > this.maxGapMs) {
                    this.slotStart = sample.timeMs;
                    break;
                }
            }

            for (const channel of CHANNELS) {
                const v = sample.values[channel.ordinal];
                if (Number.isNaN(v)) continue;
                const i = channel.ordinal;
                this.sums[i] += v;
                this.counts[i]++;
                if (channel.resampleMode === PEAK_NEGATIVE) {
                    const current = this.extremes[i];
                    if (Number.isNaN(current) || v < current) this.extremes[i] = v;
                }
            }
            this.pending = true;
        }

        flush(out) {
            this.emit(out);
            this.reset();
        }

        emit(out) {
            if (!this.pending) return;
            const values = emptyValues();
            for (let i = 0; i < CHANNELS.length; i++) {
                let value;
                if (this.counts[i] > 0) {
                    value = CHANNELS[i].resampleMode === PEAK_NEGATIVE
                        ? this.extremes[i]
                        : this.sums[i] / this.counts[i];
                    this.lastKnown[i] = value;
                } else {
                    value = this.lastKnown[i];
                }
                values[i] = value;
            }
            out(new Sample(this.slotStart, values));
            this.sums.fill(0);
            this.counts.fill(0);
            this.extremes.fill(NaN);
            this.pending = false;
        }

        reset() {
            this.sums.fill(0);
            this.counts.fill(0);
            this.extremes.fill(NaN);
            this.pending = false;
        }
    }

    /** Why a channel can or cannot be trusted as evidence. */
    const STATUS_OK = 'ok';
    /** Not in the file at all. Detectors needing it are skipped, not failed. */
    const STATUS_ABSENT = 'absent';
    /** Present but never changes across the whole log — almost always unwired. */
    const STATUS_CONSTANT = 'constant';
    /** Present but mostly outside physically plausible bounds. */
    const STATUS_IMPLAUSIBLE = 'implausible';

    const CONSTANT_EPSILON = 1e-9;
    const IMPLAUSIBLE_FRACTION = 0.10;

    /**
     * Single-pass validity accumulator.
     *
     * This exists because of a specific failure mode: the reference log has
     * five analog inputs pinned at a constant voltage because nothing is wired
     * to them. Without this gate the detector set would confidently report five
     * dead sensors on a perfectly healthy car. A channel nobody connected is
     * not a fault — it is an absence of evidence, and the two must never be
     * confused.
     */
    class ChannelHealthTracker {
        constructor() {
            const size = CHANNELS.length;
            this.counts = new Float64Array(size);
            this.sums = new Float64Array(size);
            this.mins = new Float64Array(size).fill(Infinity);
            this.maxs = new Float64Array(size).fill(-Infinity);
            this.outOfRange = new Float64Array(size);
        }

        observe(channel, value) {
            if (Number.isNaN(value)) return;
            const i = channel.ordinal;
            this.counts[i]++;
            this.sums[i] += value;
            if (value < this.mins[i]) this.mins[i] = value;
            if (value > this.maxs[i]) this.maxs[i] = value;
            if (value < channel.plausibleMin || value > channel.plausibleMax) this.outOfRange[i]++;
        }

        finish() {
            const health = new Map();
            for (const channel of CHANNELS) {
                const i = channel.ordinal;
                const n = this.counts[i];
                if (n === 0) {
                    health.set(channel, {
                        channel, status: STATUS_ABSENT, samples: 0,
                        min: NaN, max: NaN, mean: NaN, outOfRangeFraction: 0, usable: false,
                    });
                    continue;
                }
                const oorFraction = this.outOfRange[i] / n;
                let status;
                if (oorFraction > IMPLAUSIBLE_FRACTION) status = STATUS_IMPLAUSIBLE;
                else if (this.maxs[i] - this.mins[i] <= CONSTANT_EPSILON) status = STATUS_CONSTANT;
                else status = STATUS_OK;

                health.set(channel, {
                    channel, status, samples: n,
                    min: this.mins[i], max: this.maxs[i], mean: this.sums[i] / n,
                    outOfRangeFraction: oorFraction,
                    usable: status === STATUS_OK,
                });
            }
            return health;
        }
    }

    /**
     * The lowest level a signal actually *held*, as opposed to the lowest value
     * it ever momentarily read.
     *
     * Keeps a sliding-window maximum and tracks the smallest one seen. A single
     * dropped sample can never be the maximum of a window, so it can never set
     * the answer - which a plain minimum does, and did: on the reference log the
     * intake sensor dithers between 27.75 and 34.50 while the car sits
     * stationary with a 72 degC engine, then reads 13.50 for exactly one sample
     * and returns to 34.50. That one reading was being used as the outside air
     * temperature, inflating the measured intake rise by nearly 20 degC.
     *
     * The deque holds only entries that could still win, so memory is bounded by
     * the window rather than the length of the drive.
     */
    class SustainedMinTracker {
        constructor(spanMs) {
            this.spanMs = spanMs;
            this.deque = [];
            this.windowStartMs = null;
            this.best = NaN;
        }

        /** Ends the current window. Called across gaps, which must not be spanned. */
        reset() {
            this.deque.length = 0;
            this.windowStartMs = null;
        }

        observe(timeMs, value) {
            if (Number.isNaN(value)) return;
            if (this.windowStartMs === null) this.windowStartMs = timeMs;

            // Anything no larger than the new value can never be a later
            // window's maximum, so it is dropped rather than carried.
            while (this.deque.length && this.deque[this.deque.length - 1].v <= value) this.deque.pop();
            this.deque.push({ t: timeMs, v: value });
            while (this.deque.length && timeMs - this.deque[0].t > this.spanMs) this.deque.shift();

            // Only judge once a full window has actually been observed,
            // otherwise the start of a log reports a window of one sample.
            if (timeMs - this.windowStartMs < this.spanMs) return;
            const windowMax = this.deque[0].v;
            if (Number.isNaN(this.best) || windowMax < this.best) this.best = windowMax;
        }

        /** NaN when no complete window was ever observed - too short to judge. */
        get value() { return this.best; }
    }

    /**
     * How long the intake has to hold a temperature for it to count as ambient.
     *
     * Not load-bearing: on the reference log the answer moves from 31.5 to
     * 33.8 degC across windows from 2 s to 30 s, against 13.5 degC for the
     * single-sample minimum it replaces.
     */
    const AMBIENT_WINDOW_SECONDS = 10;

    /**
     * Channels that genuinely move from one raw sample to the next while an
     * engine is running. Slow channels like coolant repeat legitimately, so
     * they carry no information about whether the feed is live.
     */
    const LIVENESS_CHANNELS = [CH.RPM, CH.ENGINE_LOAD, CH.MAF, CH.IGNITION_ADVANCE];
    /** Below this many present liveness channels there is no way to tell. */
    const MIN_LIVENESS_CHANNELS = 3;
    /** How long every liveness channel must sit bit-identical to count as frozen. */
    const STALE_FEED_SECONDS = 2.0;

    /**
     * Finds stretches where the logger was repeating stale values.
     *
     * When an ECU stops answering - the engine is switched off, the connection
     * drops - a logger typically keeps writing its last received values rather
     * than writing nothing. Downstream that is indistinguishable from a running
     * engine holding perfectly steady, and it is worse than useless: on the
     * reference log the final 35 seconds are frozen at 824 rpm while the
     * analog input correctly records the battery falling to 12.4 V with the
     * alternator stopped, which reads as a 35-second charging fault on a car
     * that was simply parked.
     *
     * Several independent channels landing on bit-identical values is the
     * signature. A real engine is noisy: on that log the longest such stretch
     * during actual driving is 0.4 s, against 35 s for the frozen tail.
     */
    class StaleFeedTracker {
        constructor(minSeconds = STALE_FEED_SECONDS) {
            this.minMs = minSeconds * 1000;
            this.previous = null;
            this.prevTimeMs = null;
            this.runStartMs = null;
            this.spans = [];
        }

        observe(sample) {
            if (this.previous) {
                let compared = 0;
                let identical = 0;
                for (const channel of LIVENESS_CHANNELS) {
                    const before = this.previous[channel.ordinal];
                    const now = sample.values[channel.ordinal];
                    if (Number.isNaN(before) || Number.isNaN(now)) continue;
                    compared++;
                    if (before === now) identical++;
                }
                if (compared >= MIN_LIVENESS_CHANNELS && identical === compared) {
                    if (this.runStartMs === null) this.runStartMs = this.prevTimeMs;
                } else {
                    this.closeRun(this.prevTimeMs);
                }
            }
            // Row value arrays are never mutated after the reader builds them.
            this.previous = sample.values;
            this.prevTimeMs = sample.timeMs;
        }

        closeRun(endMs) {
            if (this.runStartMs !== null && endMs - this.runStartMs >= this.minMs) {
                this.spans.push({ startMs: this.runStartMs, endMs });
            }
            this.runStartMs = null;
        }

        finish() {
            this.closeRun(this.prevTimeMs);
            return this.spans;
        }
    }

    /**
     * Membership test over time-ordered spans, with a cursor rather than a scan
     * so the hot path stays O(1) per sample.
     */
    function staleFilter(spans) {
        let i = 0;
        return timeMs => {
            while (i < spans.length && timeMs > spans[i].endMs) i++;
            return i < spans.length && timeMs >= spans[i].startMs;
        };
    }

    function staleSeconds(spans) {
        return spans.reduce((total, s) => total + (s.endMs - s.startMs), 0) / 1000;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. Segment
    // ══════════════════════════════════════════════════════════════════════

    /**
     * The operating state a sample belongs to.
     *
     * This is the backbone of the whole analysis. Almost no engine measurement
     * is "good" or "bad" on its own — it is good or bad *for a given operating
     * state*. A 15% fuel trim is alarming at steady cruise and completely
     * normal two hundred milliseconds into a throttle stab. Ignition retard is
     * a knock symptom during a sustained pull and ordinary transient spark
     * management during a tip-in.
     *
     * Every detector declares which states it is valid in, and sees nothing
     * else. That single rule is what turns a pile of correlated channels into
     * an answerable question.
     */
    const STATE_DEFS = [
        ['ENGINE_OFF', 'Engine off', 'Not running - cranking, stalled or key off'],
        ['COLD_START', 'Cold start', 'Running, coolant still near ambient'],
        ['WARMUP', 'Warm-up', 'Running, coolant climbing toward operating temperature'],
        ['IDLE_WARM', 'Warm idle', 'Warm, stationary, throttle closed'],
        ['DECEL_OVERRUN', 'Overrun', 'Warm, moving, throttle closed, engine above idle'],
        ['TIP_IN', 'Throttle transient', 'Throttle moving - fuel and spark are deliberately transient here'],
        ['CRUISE_STEADY', 'Steady cruise', 'Warm, throttle and engine speed both settled'],
        ['WOT_PULL', 'Full-load pull', 'Warm, high load, throttle held open'],
        ['TRANSIENT', 'Transient', 'Warm but unsettled - none of the above'],
    ];

    const STATES = STATE_DEFS.map(([name, label, description], ordinal) => ({
        ordinal, name, label, description,
        isWarm: name !== 'ENGINE_OFF' && name !== 'COLD_START' && name !== 'WARMUP',
    }));

    const ST = {};
    for (const s of STATES) ST[s.name] = s;

    const WARM_STATES = STATES.filter(s => s.isWarm);

    /**
     * Sliding window over one channel, used for rate-of-change.
     *
     * Fixed capacity: memory is bounded by the window duration, not the log
     * length. At the default 5 Hz and a one-second span this holds about five
     * entries, so the array shifts are cheaper than a deque would be.
     */
    class RateWindow {
        constructor(spanMs) {
            this.spanMs = spanMs;
            this.times = [];
            this.values = [];
        }

        clear() {
            this.times.length = 0;
            this.values.length = 0;
        }

        push(timeMs, value) {
            if (Number.isNaN(value)) return;
            this.times.push(timeMs);
            this.values.push(value);
            while (this.times.length > 1 && timeMs - this.times[0] > this.spanMs) {
                this.times.shift();
                this.values.shift();
            }
        }

        span() {
            if (this.times.length < 2) return 0;
            return (this.times[this.times.length - 1] - this.times[0]) / 1000;
        }

        /**
         * Largest excursion in the window, per second.
         *
         * Deliberately max-minus-min rather than last-minus-first. An endpoint
         * difference badly under-reads a surge that begins in the middle of the
         * window: on the reference log a tip-in taking load from 101 to 407
         * mg/str reads as only 234 mg/s by endpoints — under the transient
         * threshold — and the samples were wrongly accepted as steady state.
         * Peak-to-trough sees the same event at 306 mg/s regardless of where
         * the window happens to fall.
         */
        excursionPerSec() {
            const dt = this.span();
            if (dt <= 0) return 0;
            let lo = Infinity, hi = -Infinity;
            for (const v of this.values) {
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            return (hi - lo) / dt;
        }

        /** Signed change across the window, for callers that need direction. */
        ratePerSec() {
            const dt = this.span();
            if (dt <= 0) return 0;
            return (this.values[this.values.length - 1] - this.values[0]) / dt;
        }

        /** Standard deviation inside the window — fast wobble, slow drift cancelled. */
        stdev() {
            const n = this.values.length;
            if (n < 3) return 0;
            let sum = 0;
            for (const v of this.values) sum += v;
            const mean = sum / n;
            let variance = 0;
            for (const v of this.values) variance += (v - mean) * (v - mean);
            return Math.sqrt(variance / (n - 1));
        }

        /** Absolute drop from the window's peak to its newest value. */
        dropFromPeak() {
            if (this.values.length < 2) return 0;
            let hi = -Infinity;
            for (const v of this.values) if (v > hi) hi = v;
            return hi - this.values[this.values.length - 1];
        }
    }

    const COLD_START_COOLANT_C = 50;
    const MAX_CONTINUOUS_GAP_MS = 2000;

    /**
     * Assigns an operating state to each sample.
     *
     * Order matters: transients are claimed before steady states, so a sample
     * is only ever called "steady cruise" or "full-load pull" once the throttle
     * has actually settled.
     */
    class StateSegmenter {
        /**
         * @param closedThrottlePct throttle reading that means "closed" for this
         *   vehicle, learned on the calibration pass. Null falls back to
         *   treating near-zero as closed, which is only correct for some loggers.
         */
        constructor(profile, closedThrottlePct = null, rateWindowMs = 1000) {
            this.profile = profile;
            this.closedThrottlePct = closedThrottlePct;
            this.tpsWindow = new RateWindow(rateWindowMs);
            this.rpmWindow = new RateWindow(rateWindowMs);
            this.ignitionWindow = new RateWindow(rateWindowMs);
            this.loadWindow = new RateWindow(rateWindowMs);
            this.lastTimeMs = null;
        }

        analyze(sample) {
            const discontinuity = this.lastTimeMs !== null &&
                sample.timeMs - this.lastTimeMs > MAX_CONTINUOUS_GAP_MS;
            if (discontinuity) {
                this.tpsWindow.clear();
                this.rpmWindow.clear();
                this.ignitionWindow.clear();
                this.loadWindow.clear();
            }
            this.lastTimeMs = sample.timeMs;

            this.tpsWindow.push(sample.timeMs, sample.get(CH.TPS));
            this.rpmWindow.push(sample.timeMs, sample.get(CH.RPM));
            this.ignitionWindow.push(sample.timeMs, sample.get(CH.IGNITION_ADVANCE));
            this.loadWindow.push(sample.timeMs, sample.get(CH.ENGINE_LOAD));

            const tpsRate = discontinuity ? 0 : this.tpsWindow.excursionPerSec();
            const rpmRate = discontinuity ? 0 : this.rpmWindow.ratePerSec();
            const loadRate = discontinuity ? 0 : this.loadWindow.excursionPerSec();
            const retard = discontinuity ? 0 : this.ignitionWindow.dropFromPeak();
            const roughness = discontinuity ? 0 : this.rpmWindow.stdev();

            return {
                sample,
                timeMs: sample.timeMs,
                state: this.classify(sample, tpsRate, rpmRate, loadRate),
                tpsRatePctPerSec: tpsRate,
                rpmRatePerSec: rpmRate,
                ignitionRetardDeg: retard,
                rpmRoughness: roughness,
                discontinuity,
                get: channel => sample.get(channel),
            };
        }

        classify(sample, tpsRate, rpmRate, loadRate) {
            const profile = this.profile;
            const rpm = sample.get(CH.RPM);
            if (Number.isNaN(rpm) || rpm < profile.runningRpmMin) return ST.ENGINE_OFF;

            const coolant = sample.get(CH.COOLANT_TEMP);
            if (!Number.isNaN(coolant)) {
                if (coolant < COLD_START_COOLANT_C) return ST.COLD_START;
                if (coolant < profile.warmCoolantC) return ST.WARMUP;
            }

            // Throttle or load in motion: fuelling and spark are transient by
            // design, so nothing steady-state may be concluded from these
            // samples. Either channel can declare the transient, because a
            // throttle sensor with a dead zone will sit at zero through real
            // pedal movement that load registers clearly.
            const throttleMoving = Math.abs(tpsRate) > profile.steadyTpsRatePctPerSec;
            const loadMoving = Math.abs(loadRate) > profile.steadyLoadRatePerSec;
            if (throttleMoving || loadMoving) return ST.TIP_IN;

            const tps = sample.get(CH.TPS);
            const speed = sample.get(CH.VEHICLE_SPEED);
            const load = sample.get(CH.ENGINE_LOAD);
            const closedReference = this.closedThrottlePct === null ? 0 : this.closedThrottlePct;
            const closedThrottle = !Number.isNaN(tps) && tps <= closedReference + profile.closedThrottleBandPct;

            // Overrun needs corroboration from load. A closed-throttle reading
            // on its own says only that the sensor reads zero, not that the
            // engine has stopped making power.
            const lowLoad = !Number.isNaN(load) && load <= profile.overrunLoadMax;
            if (closedThrottle && lowLoad && rpm > profile.idleRpmMax &&
                !Number.isNaN(speed) && speed > profile.idleSpeedMaxKph) {
                return ST.DECEL_OVERRUN;
            }
            if (closedThrottle && rpm <= profile.idleRpmMax &&
                (Number.isNaN(speed) || speed <= profile.idleSpeedMaxKph)) {
                return ST.IDLE_WARM;
            }

            const highLoad = (!Number.isNaN(tps) && tps >= profile.wotTpsPct) ||
                (!Number.isNaN(load) && load >= profile.highLoadThreshold);
            if (highLoad) return ST.WOT_PULL;

            if (Math.abs(rpmRate) <= profile.steadyRpmRatePerSec) return ST.CRUISE_STEADY;

            return ST.TRANSIENT;
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 4. Aggregate
    // ══════════════════════════════════════════════════════════════════════

    /** Engine speed bands. Coarse on purpose — finer bands thin the evidence. */
    const RPM_BINS = [
        { name: 'IDLE', lo: 0, hi: 1000, label: '<1000' },
        { name: 'LOW', lo: 1000, hi: 1500, label: '1000-1500' },
        { name: 'MID_LOW', lo: 1500, hi: 2000, label: '1500-2000' },
        { name: 'MID', lo: 2000, hi: 2500, label: '2000-2500' },
        { name: 'MID_HIGH', lo: 2500, hi: 3500, label: '2500-3500' },
        { name: 'HIGH', lo: 3500, hi: 4500, label: '3500-4500' },
        { name: 'VERY_HIGH', lo: 4500, hi: Infinity, label: '>4500' },
    ];

    function rpmBinOf(rpm) {
        if (Number.isNaN(rpm)) return null;
        return RPM_BINS.find(b => rpm >= b.lo && rpm < b.hi) || null;
    }

    /**
     * Engine load bands, in mg/stroke.
     *
     * The absolute boundaries are engine-specific, which is why they are scaled
     * by the profile's high-load threshold rather than hardcoded: what matters
     * to every detector is the *shape* of a measurement across load, not the
     * raw number.
     */
    const LOAD_BINS = [
        { name: 'VERY_LOW', lo: 0, hi: 0.25, label: 'very low' },
        { name: 'LOW', lo: 0.25, hi: 0.375, label: 'low' },
        { name: 'MEDIUM', lo: 0.375, hi: 0.625, label: 'medium' },
        { name: 'HIGH', lo: 0.625, hi: 1.125, label: 'high' },
        { name: 'VERY_HIGH', lo: 1.125, hi: Infinity, label: 'very high' },
    ];

    const LB = {};
    for (const b of LOAD_BINS) LB[b.name] = b;

    const LOW_LOAD_BINS = [LB.VERY_LOW, LB.LOW];
    const HIGH_LOAD_BINS = [LB.HIGH, LB.VERY_HIGH];

    function loadBinOf(load, highLoadThreshold) {
        if (Number.isNaN(load) || highLoadThreshold <= 0) return null;
        const fraction = load / highLoadThreshold;
        return LOAD_BINS.find(b => fraction >= b.lo && fraction < b.hi) || null;
    }

    const HISTOGRAM_BUCKETS = 64;

    /** Channels where the shape of the distribution carries the diagnosis. */
    const QUANTILE_CHANNELS = new Set([
        CH.LAMBDA_INT_1, CH.LAMBDA_INT_2, CH.IGNITION_ADVANCE, CH.RPM,
        CH.ENGINE_LOAD, CH.MAF, CH.SYSTEM_VOLTAGE, CH.COOLANT_TEMP,
        CH.KNOCK_CORRECTION, CH.CAM_ADVANCE, CH.TPS,
    ]);

    /**
     * Streaming statistics for one channel inside one analysis cell.
     *
     * Mean and variance use Welford's method — numerically stable and O(1)
     * memory. Quantiles come from a fixed-width histogram over the channel's
     * plausible range, which is approximate but bounded: exact quantiles would
     * mean retaining every sample, which is exactly the thing that must not
     * scale with drive length.
     *
     * The histogram is allocated lazily and only for channels whose
     * *distribution* matters. For everything else, mean/min/max/stdev is enough.
     */
    class Accum {
        constructor(channel) {
            this.channel = channel;
            this.count = 0;
            this.mean = 0;
            this.m2 = 0;
            this.min = Infinity;
            this.max = -Infinity;
            this.wantsHistogram = QUANTILE_CHANNELS.has(channel);
            this.hist = null;
            this.histMin = channel.plausibleMin;
            this.histMax = channel.plausibleMax;
        }

        add(value) {
            if (Number.isNaN(value)) return;
            this.count++;
            const delta = value - this.mean;
            this.mean += delta / this.count;
            this.m2 += delta * (value - this.mean);
            if (value < this.min) this.min = value;
            if (value > this.max) this.max = value;

            if (this.wantsHistogram) {
                if (!this.hist) this.hist = new Int32Array(HISTOGRAM_BUCKETS);
                const span = this.histMax - this.histMin;
                if (span > 0) {
                    const raw = Math.trunc(((value - this.histMin) / span) * HISTOGRAM_BUCKETS);
                    const idx = Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, raw));
                    this.hist[idx]++;
                }
            }
        }

        /** Folds other accumulators of the same channel into this one. */
        absorbAll(others) {
            for (const other of others) {
                if (other.count === 0) continue;
                if (this.count === 0) {
                    this.count = other.count;
                    this.mean = other.mean;
                    this.m2 = other.m2;
                    this.min = other.min;
                    this.max = other.max;
                } else {
                    const delta = other.mean - this.mean;
                    const total = this.count + other.count;
                    // Chan et al. parallel variance: exact, not an approximation
                    // of the pooled variance.
                    this.m2 += other.m2 + delta * delta * this.count * other.count / total;
                    this.mean += delta * other.count / total;
                    this.count = total;
                    if (other.min < this.min) this.min = other.min;
                    if (other.max > this.max) this.max = other.max;
                }
                if (!other.hist) continue;
                if (!this.hist) this.hist = new Int32Array(HISTOGRAM_BUCKETS);
                for (let i = 0; i < HISTOGRAM_BUCKETS; i++) this.hist[i] += other.hist[i];
            }
        }

        get stdev() { return this.count > 1 ? Math.sqrt(this.m2 / (this.count - 1)) : 0; }
        get isEmpty() { return this.count === 0; }

        /**
         * Approximate quantile in [0,1]. NaN when the channel carries no
         * histogram or no data. Resolution is one bucket — about 1.6% of the
         * channel's plausible range.
         */
        quantile(q) {
            if (!this.hist || this.count === 0) return NaN;
            const target = q * this.count;
            let cumulative = 0;
            for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
                const bucket = this.hist[i];
                if (bucket === 0) continue;
                if (cumulative + bucket >= target) {
                    const within = Math.min(1, Math.max(0, (target - cumulative) / bucket));
                    const width = (this.histMax - this.histMin) / HISTOGRAM_BUCKETS;
                    return this.histMin + (i + within) * width;
                }
                cumulative += bucket;
            }
            return this.max;
        }

        get median() { return this.quantile(0.5); }
    }

    /**
     * Merges accumulators from several cells into one.
     *
     * Count, mean, variance, min and max combine exactly, and the histograms
     * add bucket-wise because every accumulator for a given channel uses the
     * same range. So "fuel trim across all warm steady states" is a real
     * statistic, not an average of averages.
     */
    function mergeAccums(channel, parts) {
        const usable = parts.filter(p => p && !p.isEmpty);
        if (usable.length === 0) return null;
        if (usable.length === 1) return usable[0];
        const merged = new Accum(channel);
        merged.absorbAll(usable);
        return merged;
    }

    /** All channels for one analysis cell. Accumulators are created lazily. */
    class ChannelStats {
        constructor() {
            this.accums = new Array(CHANNELS.length).fill(null);
            this.samples = 0;
            this.firstTimeMs = Infinity;
            this.lastTimeMs = -Infinity;
        }

        observe(timeMs, channel, value) {
            if (Number.isNaN(value)) return;
            const i = channel.ordinal;
            let accum = this.accums[i];
            if (!accum) { accum = new Accum(channel); this.accums[i] = accum; }
            accum.add(value);
            if (timeMs < this.firstTimeMs) this.firstTimeMs = timeMs;
            if (timeMs > this.lastTimeMs) this.lastTimeMs = timeMs;
        }

        countSample() { this.samples++; }

        get(channel) { return this.accums[channel.ordinal]; }

        countOf(channel) {
            const accum = this.accums[channel.ordinal];
            return accum ? accum.count : 0;
        }

        /** Wall-clock seconds this cell covers — the basis for every dwell gate. */
        get spanSeconds() {
            return this.lastTimeMs >= this.firstTimeMs ? (this.lastTimeMs - this.firstTimeMs) / 1000 : 0;
        }
    }

    /** 20 s at the default rate. Below this a "typical" value is not typical. */
    const MIN_SPARK_CELL_SAMPLES = 100;

    /**
     * The engine's own ignition map, learned from the drive.
     *
     * This exists to fix a fundamental error in detecting knock from ignition
     * advance alone. Advance is *supposed* to fall as load rises — that is the
     * shape of every spark map ever calibrated. On the reference log, timing
     * moving from 20 degrees at 150 mg/str to 8 degrees at 320 mg/str looks
     * like a violent 12-degree retard to a rule watching advance over time, and
     * is in fact the ECU reading its own table exactly as designed.
     *
     * The only sound question is "is timing lower than this engine normally
     * runs *at this rpm and load*", which needs a baseline per operating point.
     * Learning it from the log itself means no per-vehicle spark map has to be
     * shipped, and the baseline is automatically correct for the fuel, altitude
     * and state of tune the log was recorded in.
     *
     * Cost: one extra pass over the file, because the baseline is not complete
     * until the log is. Memory is unaffected — the grid is 35 cells.
     */
    class SparkMap {
        constructor() { this.cells = new Map(); }

        observe(rpm, load, advance, highLoadThreshold) {
            if (Number.isNaN(advance)) return;
            const rpmBin = rpmBinOf(rpm);
            if (!rpmBin) return;
            const loadBin = loadBinOf(load, highLoadThreshold);
            if (!loadBin) return;
            const key = rpmBin.name + '|' + loadBin.name;
            let cell = this.cells.get(key);
            if (!cell) { cell = new Accum(CH.IGNITION_ADVANCE); this.cells.set(key, cell); }
            cell.add(advance);
        }

        /**
         * Typical advance at this operating point, or null when the cell holds
         * too little data to be a baseline. Returning null — rather than a
         * guess — means the knock detector simply stays quiet in operating
         * points the drive never really visited.
         */
        baselineFor(rpm, load, highLoadThreshold) {
            const rpmBin = rpmBinOf(rpm);
            if (!rpmBin) return null;
            const loadBin = loadBinOf(load, highLoadThreshold);
            if (!loadBin) return null;
            const cell = this.cells.get(rpmBin.name + '|' + loadBin.name);
            if (!cell || cell.count < MIN_SPARK_CELL_SAMPLES) return null;
            const median = cell.median;
            return Number.isNaN(median) ? null : median;
        }

        get cellCount() { return this.cells.size; }
    }

    /** Discrete things that happen at a point in the timeline. */
    const EVENT_TYPES = {
        KNOCK_RETARD: 'Ignition retard under load',
        KNOCK_CONFIRMED: 'Knock correction applied by the ECU',
        TRIM_RAIL: 'Fuel trim at authority limit',
        OVERHEAT: 'Coolant or oil over temperature',
        VOLTAGE_SAG: 'System voltage sag while running',
        IDLE_WOBBLE: 'Unstable idle speed',
    };

    /**
     * Collects events with per-type dead-time coalescing and a hard retention cap.
     *
     * "Coalesced" is the entire point. At 5 Hz a two-second physical event
     * produces ten consecutive matching samples; reporting ten events would be
     * an outright lie about how often it happened. On the reference log a naive
     * per-sample ignition-retard rule fires 679 times for what is really about
     * fourteen distinct moments.
     *
     * The cap matters on long drives: a car with a genuinely failing sensor
     * could otherwise produce tens of thousands of events and blow the memory
     * budget the rest of the design protects. Counts stay exact; only the
     * retained detail is bounded.
     */
    class EventCollector {
        constructor(deadTimeMs, retainPerType = 100) {
            this.deadTimeMs = deadTimeMs;
            this.retainPerType = retainPerType;
            this.retained = new Map();
            this.totals = new Map();
            this.open = new Map();
        }

        record(type, timeMs, magnitude, context = {}) {
            const current = this.open.get(type);
            if (current && timeMs - current.endMs <= this.deadTimeMs) {
                // Same physical occurrence, still ongoing.
                current.endMs = timeMs;
                current.sampleCount++;
                if (magnitude > current.peakMagnitude) {
                    current.peakMagnitude = magnitude;
                    Object.assign(current.context, context);
                }
                return;
            }
            const event = {
                type, startMs: timeMs, endMs: timeMs,
                peakMagnitude: magnitude, sampleCount: 1,
                context: Object.assign({}, context),
                get durationSec() { return (this.endMs - this.startMs) / 1000; },
            };
            this.open.set(type, event);
            this.totals.set(type, (this.totals.get(type) || 0) + 1);
            let list = this.retained.get(type);
            if (!list) { list = []; this.retained.set(type, list); }
            if (list.length < this.retainPerType) list.push(event);
        }

        /** Distinct occurrences seen, including any dropped by the retention cap. */
        countOf(type) { return this.totals.get(type) || 0; }

        eventsOf(type) { return this.retained.get(type) || []; }

        all() {
            const out = [];
            for (const list of this.retained.values()) out.push(...list);
            return out.sort((a, b) => a.startMs - b.startMs);
        }
    }

    /** At the default 5 Hz this is 0.6 s of continuously held retard. */
    const KNOCK_MIN_CONSECUTIVE = 3;
    /**
     * A "closed" reading above this is not a resting throttle, it is a channel
     * we do not understand — better to fall back than to declare half the drive
     * closed-throttle.
     */
    const MAX_PLAUSIBLE_CLOSED_TPS = 35;

    /**
     * Builds a drive summary in a single streaming pass.
     *
     * Cells are created lazily, so a log that never sees full load never
     * allocates a full-load cell.
     */
    class SummaryBuilder {
        /**
         * @param ignitionBaseline spark map from a previous pass. Null on the
         *   calibration pass, where the map is being learned and knock cannot
         *   yet be judged — so no knock-retard events are produced then.
         */
        constructor(profile, ignitionBaseline = null) {
            this.profile = profile;
            this.ignitionBaseline = ignitionBaseline;
            this.byState = new Map();
            this.byStateLoad = new Map();
            this.byStateRpm = new Map();
            this.stateSeconds = new Map();
            this.events = new EventCollector(Math.trunc(profile.eventDeadTimeSec * 1000));
            this.sparkMap = new SparkMap();

            this.lastTimeMs = null;
            this.runningMs = 0;
            this.startCoolant = null;
            this.peakCoolant = null;
            this.peakOil = null;
            this.runningStartMs = null;
            this.warmReachedMs = null;
            this.knockRun = 0;
            this.minRunningTps = NaN;
            this.ambientTracker = new SustainedMinTracker(AMBIENT_WINDOW_SECONDS * 1000);
        }

        accept(analyzed) {
            const sample = analyzed.sample;
            const state = analyzed.state;

            const dtSec = (this.lastTimeMs === null || analyzed.discontinuity)
                ? 0
                : (sample.timeMs - this.lastTimeMs) / 1000;
            this.lastTimeMs = sample.timeMs;
            this.stateSeconds.set(state, (this.stateSeconds.get(state) || 0) + dtSec);
            if (state !== ST.ENGINE_OFF) this.runningMs += dtSec * 1000;

            this.trackTimeline(analyzed);

            // Learn the closed-throttle reading. Taken while running only: a
            // throttle reading captured with the engine stopped says nothing
            // about where the pedal rests when it is idling.
            if (state !== ST.ENGINE_OFF) {
                const tps = sample.get(CH.TPS);
                if (!Number.isNaN(tps) && (Number.isNaN(this.minRunningTps) || tps < this.minRunningTps)) {
                    this.minRunningTps = tps;
                }
            }

            const stateCell = this.cellFor(this.byState, state);
            stateCell.countSample();
            this.observeAll(stateCell, sample.timeMs, analyzed);

            const loadBin = loadBinOf(sample.get(CH.ENGINE_LOAD), this.profile.highLoadThreshold);
            if (loadBin) {
                const cell = this.cellFor(this.byStateLoad, state.name + '|' + loadBin.name);
                cell.countSample();
                this.observeAll(cell, sample.timeMs, analyzed);
            }
            const rpmBin = rpmBinOf(sample.get(CH.RPM));
            if (rpmBin) {
                const cell = this.cellFor(this.byStateRpm, state.name + '|' + rpmBin.name);
                cell.countSample();
                this.observeAll(cell, sample.timeMs, analyzed);
            }

            if (state.isWarm) {
                this.sparkMap.observe(
                    sample.get(CH.RPM), sample.get(CH.ENGINE_LOAD),
                    sample.get(CH.IGNITION_ADVANCE), this.profile.highLoadThreshold,
                );
            }

            this.scanEvents(analyzed);
        }

        cellFor(map, key) {
            let cell = map.get(key);
            if (!cell) { cell = new ChannelStats(); map.set(key, cell); }
            return cell;
        }

        observeAll(cell, timeMs, analyzed) {
            for (const channel of CHANNELS) {
                const v = analyzed.sample.values[channel.ordinal];
                if (!Number.isNaN(v)) cell.observe(timeMs, channel, v);
            }
            // Derived channels are not in the sample, so they are folded in
            // explicitly.
            if (!analyzed.discontinuity && !Number.isNaN(analyzed.sample.get(CH.RPM))) {
                cell.observe(timeMs, CH.RPM_ROUGHNESS, analyzed.rpmRoughness);
            }
        }

        trackTimeline(analyzed) {
            const coolant = analyzed.sample.get(CH.COOLANT_TEMP);
            const oil = analyzed.sample.get(CH.OIL_TEMP);

            // Outside air, inferred from the coolest the intake ever settles at.
            // A gap means the far side is a different stretch of driving, so the
            // window restarts rather than spanning it.
            if (analyzed.discontinuity) this.ambientTracker.reset();
            this.ambientTracker.observe(analyzed.timeMs, analyzed.sample.get(CH.INTAKE_AIR_TEMP));
            if (analyzed.state !== ST.ENGINE_OFF && this.runningStartMs === null) {
                this.runningStartMs = analyzed.timeMs;
                if (!Number.isNaN(coolant)) this.startCoolant = coolant;
            }
            if (!Number.isNaN(coolant)) {
                this.peakCoolant = this.peakCoolant === null ? coolant : Math.max(this.peakCoolant, coolant);
                if (this.warmReachedMs === null && coolant >= this.profile.warmCoolantC) {
                    this.warmReachedMs = analyzed.timeMs;
                }
            }
            if (!Number.isNaN(oil)) {
                this.peakOil = this.peakOil === null ? oil : Math.max(this.peakOil, oil);
            }
        }

        /**
         * Point-in-time detections. Every one of these is gated on operating
         * state before it is even considered — that gate, plus the collector's
         * dead time, is what separates a real occurrence from a burst of
         * correlated samples.
         */
        scanEvents(analyzed) {
            const t = analyzed.timeMs;
            const profile = this.profile;
            const s = analyzed.sample;

            // Confirmed knock: the ECU telling us directly how much timing it
            // pulled. No inference, no baseline, no operating-state gate needed
            // — the signal means exactly one thing. It is also not subject to
            // the spike problem the inferred version has, because a correction
            // is held by the ECU rather than being a difference between two
            // noisy samples.
            const knockCorrection = s.get(CH.KNOCK_CORRECTION);
            if (!Number.isNaN(knockCorrection) && knockCorrection <= profile.knockCorrectionDeg) {
                this.events.record(EVENT_TYPES.KNOCK_CONFIRMED, t, Math.abs(knockCorrection), {
                    correction: knockCorrection,
                    load: s.get(CH.ENGINE_LOAD),
                    rpm: s.get(CH.RPM),
                    iat: s.get(CH.INTAKE_AIR_TEMP),
                });
            }

            // Knock proxy: timing measurably below what this engine normally
            // runs at this exact operating point. Comparing against the learned
            // baseline rather than against the recent past is what separates
            // real retard from the spark map's own load and rpm axes.
            const baseline = this.ignitionBaseline;
            if (baseline && (analyzed.state === ST.WOT_PULL || analyzed.state === ST.CRUISE_STEADY)) {
                const advance = s.get(CH.IGNITION_ADVANCE);
                const load = s.get(CH.ENGINE_LOAD);
                const rpm = s.get(CH.RPM);
                const expected = baseline.baselineFor(rpm, load, profile.highLoadThreshold);
                const deficit = (expected !== null && !Number.isNaN(advance)) ? expected - advance : NaN;

                if (!Number.isNaN(deficit) && deficit >= profile.knockRetardDeg &&
                    !Number.isNaN(load) && load >= profile.highLoadThreshold * 0.6) {
                    this.knockRun++;
                    // Logged timing is spiky: on the reference log a single
                    // sample reads -9.4 deg between neighbours of 13.5 and 8.3,
                    // 130 ms apart. Real knock retard is held for as long as the
                    // ECU needs it, so a run of consecutive samples is required.
                    if (this.knockRun >= KNOCK_MIN_CONSECUTIVE) {
                        this.events.record(EVENT_TYPES.KNOCK_RETARD, t, deficit, {
                            load, rpm, advance, expected,
                        });
                    }
                } else {
                    this.knockRun = 0;
                }
            }

            if (analyzed.state.isWarm) {
                for (const channel of [CH.LAMBDA_INT_1, CH.LAMBDA_INT_2]) {
                    const trim = s.get(channel);
                    if (!Number.isNaN(trim) && Math.abs(trim) >= profile.trimRailPct) {
                        this.events.record(EVENT_TYPES.TRIM_RAIL, t, Math.abs(trim), {
                            trim, bank: channel === CH.LAMBDA_INT_1 ? 1 : 2,
                            load: s.get(CH.ENGINE_LOAD),
                        });
                    }
                }
            }

            const coolant = s.get(CH.COOLANT_TEMP);
            if (!Number.isNaN(coolant) && coolant >= profile.overheatCoolantC) {
                this.events.record(EVENT_TYPES.OVERHEAT, t, coolant, { coolant });
            }
            const oil = s.get(CH.OIL_TEMP);
            if (!Number.isNaN(oil) && oil >= profile.overheatOilC) {
                this.events.record(EVENT_TYPES.OVERHEAT, t, oil, { oil });
            }

            const volts = s.get(CH.SYSTEM_VOLTAGE);
            if (analyzed.state !== ST.ENGINE_OFF && !Number.isNaN(volts) && volts < profile.chargingMinV) {
                this.events.record(EVENT_TYPES.VOLTAGE_SAG, t, profile.chargingMinV - volts, { volts });
            }
        }

        /** What this pass learned, handed to the next pass. */
        calibration() {
            const closed = (!Number.isNaN(this.minRunningTps) && this.minRunningTps <= MAX_PLAUSIBLE_CLOSED_TPS)
                ? this.minRunningTps
                : null;
            return { sparkMap: this.sparkMap, closedThrottlePct: closed };
        }

        build(readStats, health, staleSpans = []) {
            const secondsToWarm = (this.warmReachedMs !== null && this.runningStartMs !== null)
                ? (this.warmReachedMs - this.runningStartMs) / 1000
                : null;

            const timeline = {
                runningSeconds: this.runningMs / 1000,
                startCoolantC: this.startCoolant,
                peakCoolantC: this.peakCoolant,
                peakOilC: this.peakOil,
                secondsToWarm,
                hasColdStart: (this.startCoolant === null ? Infinity : this.startCoolant) < this.profile.warmCoolantC,
                ambientEstimateC: this.ambientTracker.value,
            };

            return new DriveSummary({
                profile: this.profile,
                readStats,
                channelHealth: health,
                byState: this.byState,
                byStateLoad: this.byStateLoad,
                byStateRpm: this.byStateRpm,
                stateSeconds: this.stateSeconds,
                events: this.events,
                timeline,
                sparkMap: this.sparkMap,
                staleSpans,
            });
        }
    }

    /**
     * The whole drive, reduced to a bounded structure.
     *
     * This is the object every detector sees — none of them touch a raw sample.
     * A ten-minute log and a six-hour log produce a summary of the same size,
     * which is what makes analysis time and memory independent of drive length.
     */
    class DriveSummary {
        constructor(fields) { Object.assign(this, fields); }

        state(state) { return this.byState.get(state) || null; }

        isUsable(channel) {
            const health = this.channelHealth.get(channel);
            return !!health && health.usable;
        }

        allUsable(channels) { return channels.every(c => this.isUsable(c)); }

        secondsIn(states) {
            return states.reduce((sum, s) => sum + (this.stateSeconds.get(s) || 0), 0);
        }

        loadCell(state, bin) { return this.byStateLoad.get(state.name + '|' + bin.name) || null; }

        rpmCell(state, bin) { return this.byStateRpm.get(state.name + '|' + bin.name) || null; }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. Detect
    // ══════════════════════════════════════════════════════════════════════

    const SEVERITY = {
        INFO: { rank: 0, name: 'INFO', label: 'Info' },
        LOW: { rank: 1, name: 'LOW', label: 'Minor' },
        MODERATE: { rank: 2, name: 'MODERATE', label: 'Should investigate' },
        HIGH: { rank: 3, name: 'HIGH', label: 'Needs attention' },
        CRITICAL: { rank: 4, name: 'CRITICAL', label: 'Stop driving / fix now' },
    };

    /**
     * How much the data itself supports the conclusion.
     *
     * Kept separate from severity because they are genuinely different axes: an
     * overheat is severe and certain, a misfire inferred from engine-speed
     * wobble is moderate and shaky. Collapsing them into one number is how
     * diagnostic tools end up untrustworthy.
     */
    const CONFIDENCE = {
        LOW: { rank: 0, name: 'LOW', label: 'Weak signal' },
        MEDIUM: { rank: 1, name: 'MEDIUM', label: 'Consistent with the data' },
        HIGH: { rank: 2, name: 'HIGH', label: 'Strongly supported' },
    };

    const SUBSYSTEM = {
        FUEL: 'Fuel & mixture',
        AIR: 'Air & intake',
        IGNITION: 'Ignition',
        COOLING: 'Cooling',
        ELECTRICAL: 'Electrical',
        IDLE: 'Idle control',
        SENSORS: 'Sensors & logging',
    };

    /** One supporting measurement, phrased so a human can go and check it. */
    function evidence(label, value, timeMs = null) {
        return { label, value, timeMs };
    }

    /** 30 seconds at the default 5 Hz. Below this a binned cell is noise. */
    const MIN_CELL_SAMPLES = 150;

    /** Query helpers shared by every detector, so none re-implements binning. */
    class DetectorContext {
        constructor(summary) { this.summary = summary; }

        /** Merged statistic for a channel across states — exact, not an average of averages. */
        across(channel, states) {
            return mergeAccums(channel, states.map(s => {
                const cell = this.summary.byState.get(s);
                return cell ? cell.get(channel) : null;
            }));
        }

        /** Merged statistic for a channel inside the given load bins, across states. */
        inLoadBins(channel, states, bins) {
            const parts = [];
            for (const state of states) {
                for (const bin of bins) {
                    const cell = this.summary.loadCell(state, bin);
                    if (cell) parts.push(cell.get(channel));
                }
            }
            return mergeAccums(channel, parts);
        }

        secondsIn(states) { return this.summary.secondsIn(states); }

        fmt(value, decimals = 2) {
            return (value === null || value === undefined || Number.isNaN(value))
                ? 'n/a'
                : value.toFixed(decimals);
        }

        fmtTime(timeMs) {
            const totalSec = Math.trunc(timeMs / 1000);
            const min = Math.trunc(totalSec / 60);
            const sec = totalSec % 60;
            return min + ':' + String(sec).padStart(2, '0');
        }
    }

    const WARM_STEADY = [ST.IDLE_WARM, ST.CRUISE_STEADY, ST.WOT_PULL];

    /**
     * Fuel trim from whichever banks the log carries, merged.
     *
     * Both bank channels share a range, so their histograms add cleanly and the
     * merged quantiles are real. Merging is right for whole-engine questions
     * ("is it lean?"); bank *imbalance* is a separate detector precisely
     * because merging would hide it.
     */
    function mergedTrim(summary, ctx, states, bins) {
        const parts = [];
        const bank1 = ctx.inLoadBins(CH.LAMBDA_INT_1, states, bins);
        if (bank1) parts.push(bank1);
        if (summary.isUsable(CH.LAMBDA_INT_2)) {
            const bank2 = ctx.inLoadBins(CH.LAMBDA_INT_2, states, bins);
            if (bank2) parts.push(bank2);
        }
        return mergeAccums(CH.LAMBDA_INT_1, parts);
    }

    // ── Fuel and mixture ──────────────────────────────────────────────────

    /**
     * Unmetered air downstream of the airflow meter — a split intake boot, a
     * failed PCV hose, a leaking gasket.
     *
     * The signature is a *shape across load*, not a single number. A fixed leak
     * admits a roughly constant mass of air, so it is a large fraction of a
     * small idle airflow and a negligible fraction of a large full-load
     * airflow: the correction is big at low load and fades as load rises. A
     * trim that is high everywhere is a different fault entirely (fuel
     * pressure, a skewed airflow meter), so the converging shape is what
     * distinguishes them — and it is only visible because the summary bins trim
     * by load.
     */
    const VacuumLeakDetector = {
        id: 'fuel.unmetered_air',
        title: 'Unmetered air (vacuum leak)',
        subSystem: SUBSYSTEM.FUEL,
        requires: [CH.LAMBDA_INT_1, CH.ENGINE_LOAD],
        validStates: [ST.IDLE_WARM, ST.CRUISE_STEADY],
        minEvidenceSeconds: 60,

        evaluate(summary, ctx) {
            const profile = summary.profile;
            const low = mergedTrim(summary, ctx, this.validStates, LOW_LOAD_BINS);
            if (!low || low.count < MIN_CELL_SAMPLES) return null;

            const lowMedian = low.median;
            if (Number.isNaN(lowMedian) || lowMedian < profile.trimSignificantPct) return null;

            const high = mergedTrim(summary, ctx, this.validStates.concat([ST.WOT_PULL]), HIGH_LOAD_BINS);
            const highMedian = (high && high.count >= MIN_CELL_SAMPLES) ? high.median : null;

            // Enriched at every load is not a leak. Hand it to the fuel-supply
            // detector instead.
            if (highMedian !== null && highMedian >= profile.trimSignificantPct) return null;

            const converges = highMedian !== null && lowMedian - highMedian >= profile.trimSignificantPct / 2;
            const confidence = (converges && lowMedian >= profile.trimSignificantPct * 1.5) ? CONFIDENCE.HIGH
                : converges ? CONFIDENCE.MEDIUM
                : CONFIDENCE.LOW;

            let text = 'The ECU is adding ' + ctx.fmt(lowMedian, 1) + '% extra fuel at low load';
            if (highMedian !== null) {
                text += ', falling to ' + ctx.fmt(highMedian, 1) + '% at high load. ' +
                    'That converging shape is characteristic of a fixed air leak after the airflow meter: ' +
                    'it dominates the small airflow at idle and disappears into the large airflow under load.';
            } else {
                text += '. The log has too little high-load driving to confirm the shape, ' +
                    'so this could also be a fuelling or airflow-meter issue.';
            }

            const ev = [evidence('Fuel trim, low load', ctx.fmt(lowMedian, 1) + '% (median of ' + low.count + ' samples)')];
            if (highMedian !== null) {
                ev.push(evidence('Fuel trim, high load', ctx.fmt(highMedian, 1) + '% (median of ' + high.count + ' samples)'));
            }
            ev.push(evidence('Low-load trim spread',
                ctx.fmt(low.quantile(0.05), 1) + '% to ' + ctx.fmt(low.quantile(0.95), 1) + '% (5th-95th pct)'));

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: lowMedian >= profile.trimRailPct ? SEVERITY.HIGH : SEVERITY.MODERATE,
                confidence,
                summary: text,
                evidence: ev,
                suggestedChecks: [
                    'Smoke-test the intake tract from the airflow meter to the throttle body',
                    'Inspect the PCV system, brake booster hose and intake boot for splits',
                    'Check for leaking intake manifold or throttle body gaskets',
                ],
                causeKey: 'lean-low-load',
            };
        },
    };

    /**
     * Sustained enrichment that does not fade with load — the engine is short
     * of fuel, or is being told there is more air than there is.
     */
    const FuelSupplyDetector = {
        id: 'fuel.supply_shortfall',
        title: 'Fuel supply shortfall at load',
        subSystem: SUBSYSTEM.FUEL,
        requires: [CH.LAMBDA_INT_1, CH.ENGINE_LOAD],
        validStates: [ST.CRUISE_STEADY, ST.WOT_PULL],
        minEvidenceSeconds: 30,

        evaluate(summary, ctx) {
            const profile = summary.profile;
            const high = mergedTrim(summary, ctx, this.validStates, HIGH_LOAD_BINS);
            if (!high || high.count < MIN_CELL_SAMPLES) return null;

            const median = high.median;
            if (Number.isNaN(median) || median < profile.trimSignificantPct) return null;

            const railEvents = summary.events.countOf(EVENT_TYPES.TRIM_RAIL);
            const atLimit = median >= profile.trimRailPct * 0.8;

            const ev = [
                evidence('Fuel trim, high load', ctx.fmt(median, 1) + '% (median of ' + high.count + ' samples)'),
                evidence('Peak high-load trim', ctx.fmt(high.max, 1) + '%'),
            ];
            if (railEvents > 0) ev.push(evidence('Trim-limit events', railEvents + ' distinct occurrences'));

            return {
                detectorId: this.id,
                title: atLimit ? 'Fuel trim at its limit under load' : this.title,
                subSystem: this.subSystem,
                severity: atLimit ? SEVERITY.HIGH : SEVERITY.MODERATE,
                confidence: (railEvents > 0 || atLimit) ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
                summary: 'Under load the ECU is adding ' + ctx.fmt(median, 1) + '% extra fuel and the correction ' +
                    'does not fade as load rises. That points at the fuel side rather than an air leak - the ' +
                    'engine cannot get the fuel it is asking for, or the airflow signal is reading high.' +
                    (railEvents > 0 ? ' The correction hit its authority limit ' + railEvents + ' separate times.' : ''),
                evidence: ev,
                suggestedChecks: [
                    'Measure fuel pressure under load, not just at idle',
                    'Check the fuel filter and pump delivery volume',
                    'Inspect injectors for restriction or fouling',
                    'Verify the airflow meter is not reading high',
                ],
                causeKey: 'lean-high-load',
            };
        },
    };

    /** Persistent enrichment beyond what the ECU can trim away, at every load. */
    const RichMixtureDetector = {
        id: 'fuel.persistent_rich',
        title: 'Engine running rich',
        subSystem: SUBSYSTEM.FUEL,
        requires: [CH.LAMBDA_INT_1],
        validStates: [ST.IDLE_WARM, ST.CRUISE_STEADY],
        minEvidenceSeconds: 60,

        evaluate(summary, ctx) {
            const profile = summary.profile;
            const parts = [];
            const bank1 = ctx.across(CH.LAMBDA_INT_1, this.validStates);
            if (bank1) parts.push(bank1);
            if (summary.isUsable(CH.LAMBDA_INT_2)) {
                const bank2 = ctx.across(CH.LAMBDA_INT_2, this.validStates);
                if (bank2) parts.push(bank2);
            }
            const trim = mergeAccums(CH.LAMBDA_INT_1, parts);
            if (!trim || trim.count < MIN_CELL_SAMPLES) return null;

            const median = trim.median;
            if (Number.isNaN(median) || median > -profile.trimSignificantPct) return null;

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: median <= -profile.trimRailPct ? SEVERITY.HIGH : SEVERITY.MODERATE,
                confidence: CONFIDENCE.MEDIUM,
                summary: 'The ECU is cutting fuel by ' + ctx.fmt(Math.abs(median), 1) + '% to hold the target ' +
                    'mixture, so something is delivering more fuel - or reporting less air - than the ' +
                    'calibration expects.',
                evidence: [
                    evidence('Fuel trim, warm steady', ctx.fmt(median, 1) + '% (median of ' + trim.count + ' samples)'),
                    evidence('Trim spread', ctx.fmt(trim.quantile(0.05), 1) + '% to ' + ctx.fmt(trim.quantile(0.95), 1) + '%'),
                ],
                suggestedChecks: [
                    'Check fuel pressure regulator and for a leaking injector',
                    'Inspect the airflow meter for contamination (a dirty element reads low)',
                    'Check intake air temperature and coolant sensor calibration',
                ],
                causeKey: 'rich',
            };
        },
    };

    /**
     * One bank correcting differently from the other.
     *
     * A whole-engine fault (fuel pressure, airflow meter) moves both banks
     * together, so a persistent split isolates the fault to one side: its
     * oxygen sensor, its injectors, or an exhaust leak ahead of its sensor.
     * This is the one question merged trim cannot answer.
     */
    const BankImbalanceDetector = {
        id: 'fuel.bank_imbalance',
        title: 'Fuel trim imbalance between banks',
        subSystem: SUBSYSTEM.FUEL,
        requires: [CH.LAMBDA_INT_1, CH.LAMBDA_INT_2],
        validStates: [ST.IDLE_WARM, ST.CRUISE_STEADY, ST.WOT_PULL],
        minEvidenceSeconds: 60,

        evaluate(summary, ctx) {
            const bank1 = ctx.across(CH.LAMBDA_INT_1, this.validStates);
            const bank2 = ctx.across(CH.LAMBDA_INT_2, this.validStates);
            if (!bank1 || !bank2) return null;
            if (bank1.count < MIN_CELL_SAMPLES || bank2.count < MIN_CELL_SAMPLES) return null;

            // Means combine exactly across cells, so the difference of means is
            // the mean difference.
            const delta = bank1.mean - bank2.mean;
            if (Math.abs(delta) < summary.profile.bankImbalancePct) return null;

            const leanBank = delta > 0 ? 1 : 2;
            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: SEVERITY.MODERATE,
                confidence: CONFIDENCE.HIGH,
                summary: 'Bank ' + leanBank + ' is being fuelled ' + ctx.fmt(Math.abs(delta), 1) + '% richer than ' +
                    'the other bank across warm running. A fault common to the whole engine would move both ' +
                    'banks together, so this isolates the problem to bank ' + leanBank + '.',
                evidence: [
                    evidence('Bank 1 mean trim', ctx.fmt(bank1.mean, 1) + '% (' + bank1.count + ' samples)'),
                    evidence('Bank 2 mean trim', ctx.fmt(bank2.mean, 1) + '% (' + bank2.count + ' samples)'),
                    evidence('Difference', ctx.fmt(Math.abs(delta), 1) + '%'),
                ],
                suggestedChecks: [
                    'Compare the oxygen sensors on both banks - swap them and see if the split follows',
                    'Check for an exhaust leak upstream of the bank ' + leanBank + ' sensor',
                    'Test bank ' + leanBank + ' injectors for flow and balance',
                ],
                causeKey: 'bank-' + leanBank,
            };
        },
    };

    // ── Cooling ───────────────────────────────────────────────────────────

    /**
     * Coolant or oil above safe temperature.
     *
     * Uses coalesced events rather than a peak reading, so a single noisy
     * sample cannot raise an alarm and a genuine sustained excursion cannot be
     * averaged away.
     */
    const OverheatDetector = {
        id: 'cooling.overheat',
        title: 'Over-temperature',
        subSystem: SUBSYSTEM.COOLING,
        requires: [CH.COOLANT_TEMP],
        validStates: STATES,
        minEvidenceSeconds: 0,

        evaluate(summary, ctx) {
            const events = summary.events.eventsOf(EVENT_TYPES.OVERHEAT);
            if (events.length === 0) return null;
            const worst = events.reduce((a, b) => (b.peakMagnitude > a.peakMagnitude ? b : a));
            const totalSec = events.reduce((sum, e) => sum + e.durationSec, 0);
            const profile = summary.profile;

            const ev = [
                evidence('Peak temperature', ctx.fmt(worst.peakMagnitude, 1) + ' degC', worst.startMs),
                evidence('First excursion at', ctx.fmtTime(events[0].startMs)),
                evidence('Time over limit', ctx.fmt(totalSec, 0) + 's across ' + events.length + ' excursion(s)'),
            ];
            if (summary.timeline.peakCoolantC !== null) {
                ev.push(evidence('Peak coolant', ctx.fmt(summary.timeline.peakCoolantC, 1) + ' degC'));
            }
            if (summary.timeline.peakOilC !== null) {
                ev.push(evidence('Peak oil', ctx.fmt(summary.timeline.peakOilC, 1) + ' degC'));
            }

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: totalSec > 60 ? SEVERITY.CRITICAL : SEVERITY.HIGH,
                confidence: CONFIDENCE.HIGH,
                summary: 'Temperature exceeded the safe limit on ' + events.length + ' occasion(s), peaking at ' +
                    ctx.fmt(worst.peakMagnitude, 1) + ' degC and staying over the limit for ' +
                    ctx.fmt(totalSec, 0) + 's in total. Coolant limit is ' +
                    ctx.fmt(profile.overheatCoolantC, 0) + ' degC, oil limit ' +
                    ctx.fmt(profile.overheatOilC, 0) + ' degC.',
                evidence: ev,
                suggestedChecks: [
                    'Check coolant level and for air in the system',
                    'Verify the cooling fan engages and the radiator is not blocked',
                    'Test the thermostat and water pump',
                ],
                causeKey: 'cooling',
            };
        },
    };

    const THERMOSTAT_MIN_RUN_SECONDS = 900;
    const THERMOSTAT_SLOW_WARMUP_SECONDS = 600;

    /**
     * A thermostat that never closes properly.
     *
     * Only answerable when the log actually starts cold, which is why it is
     * gated on the cold-start flag rather than a temperature threshold — on a
     * log that begins with a hot engine there is no warm-up to judge, and the
     * correct output is silence, not a guess.
     */
    const ThermostatStuckOpenDetector = {
        id: 'cooling.thermostat_open',
        title: 'Thermostat slow to close or stuck open',
        subSystem: SUBSYSTEM.COOLING,
        requires: [CH.COOLANT_TEMP],
        validStates: [ST.COLD_START, ST.WARMUP],
        minEvidenceSeconds: 30,

        evaluate(summary, ctx) {
            const timeline = summary.timeline;
            const profile = summary.profile;
            if (!timeline.hasColdStart) return null;

            const peak = timeline.peakCoolantC;
            if (peak === null) return null;

            const neverReachedTarget = peak < profile.thermostatTargetC &&
                timeline.runningSeconds > THERMOSTAT_MIN_RUN_SECONDS;
            const secondsToWarm = timeline.secondsToWarm === null ? Infinity : timeline.secondsToWarm;
            const slowWarmup = secondsToWarm > THERMOSTAT_SLOW_WARMUP_SECONDS;
            if (!neverReachedTarget && !slowWarmup) return null;

            let text;
            if (neverReachedTarget) {
                text = 'Coolant peaked at ' + ctx.fmt(peak, 1) + ' degC over ' +
                    ctx.fmt(timeline.runningSeconds / 60, 0) + ' minutes of running and never reached the ' +
                    ctx.fmt(profile.thermostatTargetC, 0) + ' degC it should hold. ';
            } else {
                text = 'Coolant took ' + ctx.fmt(timeline.secondsToWarm || 0, 0) + 's to reach ' +
                    ctx.fmt(profile.warmCoolantC, 0) + ' degC, which is slow. ';
            }
            text += 'A thermostat stuck partly open lets coolant circulate through the radiator before the ' +
                'engine is warm, which costs fuel economy and increases wear.';

            const ev = [];
            if (timeline.startCoolantC !== null) {
                ev.push(evidence('Coolant at start', ctx.fmt(timeline.startCoolantC, 1) + ' degC'));
            }
            ev.push(evidence('Peak coolant', ctx.fmt(peak, 1) + ' degC'));
            if (timeline.secondsToWarm !== null) {
                ev.push(evidence('Time to ' + ctx.fmt(profile.warmCoolantC, 0) + ' degC',
                    ctx.fmt(timeline.secondsToWarm, 0) + 's'));
            }
            ev.push(evidence('Running time', ctx.fmt(timeline.runningSeconds / 60, 1) + ' min'));

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: SEVERITY.LOW,
                confidence: neverReachedTarget ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
                summary: text,
                evidence: ev,
                suggestedChecks: [
                    'Replace or bench-test the thermostat',
                    'Confirm the coolant temperature sensor reads correctly against an infrared thermometer',
                ],
                causeKey: 'cooling',
            };
        },
    };

    /**
     * Restricted coolant flow.
     *
     * Compares coolant against radiator temperature once warm. Both means come
     * from the same samples in the same cells, so the difference of means is
     * exactly the mean difference — no derived channel needed. A large standing
     * gap means heat is not getting from the engine to the radiator.
     */
    const CoolantFlowDetector = {
        id: 'cooling.restricted_flow',
        title: 'Restricted coolant flow',
        subSystem: SUBSYSTEM.COOLING,
        requires: [CH.COOLANT_TEMP, CH.RADIATOR_TEMP],
        validStates: [ST.CRUISE_STEADY, ST.IDLE_WARM, ST.WOT_PULL],
        minEvidenceSeconds: 120,

        evaluate(summary, ctx) {
            const coolant = ctx.across(CH.COOLANT_TEMP, this.validStates);
            const radiator = ctx.across(CH.RADIATOR_TEMP, this.validStates);
            if (!coolant || !radiator) return null;
            if (coolant.count < MIN_CELL_SAMPLES) return null;

            const delta = coolant.mean - radiator.mean;
            if (delta < summary.profile.coolantRadiatorDeltaMaxC) return null;

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: SEVERITY.MODERATE,
                confidence: CONFIDENCE.MEDIUM,
                summary: 'Once warm, coolant runs ' + ctx.fmt(delta, 1) + ' degC hotter than the radiator on ' +
                    'average. A healthy system moves heat quickly enough to keep that gap small; a large ' +
                    'standing gap suggests coolant is not circulating properly.',
                evidence: [
                    evidence('Mean coolant (warm)', ctx.fmt(coolant.mean, 1) + ' degC'),
                    evidence('Mean radiator (warm)', ctx.fmt(radiator.mean, 1) + ' degC'),
                    evidence('Mean difference', ctx.fmt(delta, 1) + ' degC (limit ' +
                        ctx.fmt(summary.profile.coolantRadiatorDeltaMaxC, 0) + ')'),
                ],
                suggestedChecks: [
                    'Check coolant level and bleed trapped air',
                    'Inspect the water pump impeller and drive',
                    'Check the radiator for internal blockage',
                ],
                causeKey: 'cooling',
            };
        },
    };

    // ── Ignition ──────────────────────────────────────────────────────────

    const KNOCK_CONFIRMED_MIN_EPISODES = 3;
    /** Timing being corrected more than this share of the time is not occasional. */
    const KNOCK_SUSTAINED_FRACTION = 0.05;

    /**
     * Knock, measured rather than inferred.
     *
     * When the log carries the ECU's own knock correction, this replaces the
     * inferred rule entirely. The difference in evidential quality is large:
     * the inferred version has to reconstruct a spark map, exclude throttle
     * transients, reject logging spikes and still ends up saying "this timing
     * looks low for the conditions". This one reads how many degrees the ECU
     * removed.
     *
     * The correction channel is negative-going by convention — zero is no knock
     * — and is typically quantised by the ECU, which is why small dithering
     * values are ignored.
     */
    const KnockCorrectionDetector = {
        id: 'ignition.knock_confirmed',
        title: 'Engine is knocking',
        subSystem: SUBSYSTEM.IGNITION,
        requires: [CH.KNOCK_CORRECTION],
        validStates: WARM_STATES,
        minEvidenceSeconds: 60,

        evaluate(summary, ctx) {
            const profile = summary.profile;
            const episodes = summary.events.eventsOf(EVENT_TYPES.KNOCK_CONFIRMED);
            const total = summary.events.countOf(EVENT_TYPES.KNOCK_CONFIRMED);
            if (total < KNOCK_CONFIRMED_MIN_EPISODES) return null;

            const worst = episodes.reduce((a, b) => (b.peakMagnitude > a.peakMagnitude ? b : a));
            const worstDegrees = -worst.peakMagnitude;
            const severe = worstDegrees <= profile.knockCorrectionSevereDeg;

            // How much of the warm running time the ECU spent pulling timing. A
            // handful of brief corrections is normal on pump fuel; a persistent
            // correction is not.
            const knockStats = ctx.across(CH.KNOCK_CORRECTION, this.validStates);
            const activeSeconds = episodes.reduce((sum, e) => sum + e.durationSec, 0);
            const activeFraction = activeSeconds / Math.max(1, ctx.secondsIn(this.validStates));

            const loadWhenKnocking = worst.context.load;
            const rpmWhenKnocking = worst.context.rpm;
            const iatWhenKnocking = worst.context.iat;

            let text = 'The ECU detected knock and pulled timing on ' + total + ' separate occasions, worst ' +
                ctx.fmt(worstDegrees, 2) + ' degrees. Timing was being corrected for ' +
                ctx.fmt(activeFraction * 100, 1) + '% of warm running. ';
            text += severe
                ? 'Corrections this large mean the engine is knocking hard enough that the ECU is protecting ' +
                  'it, which costs power and, if it persists, damages pistons and rings.'
                : 'Small occasional corrections are normal on pump fuel; treat this as something to watch ' +
                  'rather than an emergency.';

            const longest = episodes.reduce((max, e) => Math.max(max, e.durationSec), 0);
            const ev = [
                evidence('Knock episodes', total + ' distinct occurrences'),
                evidence('Worst correction', ctx.fmt(worstDegrees, 2) + ' deg', worst.startMs),
                evidence('Longest episode', ctx.fmt(longest, 1) + 's'),
                evidence('Time with correction active', ctx.fmt(activeFraction * 100, 1) + '% of warm running'),
            ];
            if (knockStats) ev.push(evidence('Mean correction when warm', ctx.fmt(knockStats.mean, 2) + ' deg'));
            if (loadWhenKnocking !== undefined && rpmWhenKnocking !== undefined) {
                ev.push(evidence('Conditions at worst episode',
                    ctx.fmt(rpmWhenKnocking, 0) + ' rpm, load ' + ctx.fmt(loadWhenKnocking, 0) +
                    (iatWhenKnocking !== undefined ? ', intake air ' + ctx.fmt(iatWhenKnocking, 0) + ' degC' : ''),
                    worst.startMs));
            }

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: (severe && activeFraction > KNOCK_SUSTAINED_FRACTION) ? SEVERITY.HIGH
                    : (severe || activeFraction > KNOCK_SUSTAINED_FRACTION) ? SEVERITY.MODERATE
                    : SEVERITY.LOW,
                // Not an inference: the ECU reported this directly.
                confidence: CONFIDENCE.HIGH,
                summary: text,
                evidence: ev,
                suggestedChecks: [
                    'Run a tank of higher-octane fuel and re-log the same route - if the correction shrinks, it is fuel',
                    'Check intake air temperature at the knocking moments; hot intake air makes knock much more likely',
                    'Inspect spark plugs for heat range, gap and condition',
                    'Check for carbon build-up on valves and piston crowns',
                    'If the car is tuned, have the ignition map reviewed',
                ],
                causeKey: 'knock',
            };
        },
    };

    const KNOCK_RETARD_MIN_EVENTS = 3;
    const KNOCK_RETARD_SUSTAINED_SECONDS = 1.5;
    const KNOCK_RETARD_SEVERE_DEG = 12;

    /**
     * Knock retard, inferred from ignition advance.
     *
     * This detector is the clearest illustration of why the pipeline is shaped
     * the way it is. Applying the naive rule — "ignition pulled more than 6
     * degrees in a second while load is high" — directly to the reference log
     * fires 679 times. Two context gates cut that to roughly fourteen real
     * moments:
     *
     *  1. Operating state. The ECU retards spark deliberately during throttle
     *     transitions, so TIP_IN samples are excluded by construction, not by
     *     threshold. About 85% of the naive hits were the throttle moving.
     *  2. Dead time. A two-second physical event produces ten consecutive
     *     matching samples at 5 Hz; the collector merges them into one
     *     occurrence with a peak and a duration.
     *
     * Neither gate lives in this rule — both are framework behaviour — which is
     * exactly the point.
     *
     * Note the honest limit: without a knock-sensor channel this is retard
     * *correlated* with load, not a confirmed knock count.
     */
    const KnockRetardDetector = {
        id: 'ignition.knock_retard',
        title: 'Ignition retard under load (possible knock)',
        subSystem: SUBSYSTEM.IGNITION,
        requires: [CH.IGNITION_ADVANCE, CH.ENGINE_LOAD],
        validStates: [ST.WOT_PULL, ST.CRUISE_STEADY],
        minEvidenceSeconds: 30,
        // A log carrying the ECU's own knock correction makes this inference pointless.
        skipWhenPresent: [CH.KNOCK_CORRECTION],

        evaluate(summary, ctx) {
            const events = summary.events.eventsOf(EVENT_TYPES.KNOCK_RETARD);
            const total = summary.events.countOf(EVENT_TYPES.KNOCK_RETARD);
            if (total < KNOCK_RETARD_MIN_EVENTS) return null;

            const worst = events.reduce((a, b) => (b.peakMagnitude > a.peakMagnitude ? b : a));
            const sustained = events.filter(e => e.durationSec >= KNOCK_RETARD_SUSTAINED_SECONDS).length;

            const ev = [
                evidence('Distinct retard events', String(total)),
                evidence('Worst retard', ctx.fmt(worst.peakMagnitude, 1) + ' deg', worst.startMs),
            ];
            if (worst.context.load !== undefined) {
                ev.push(evidence('Load at worst event', ctx.fmt(worst.context.load, 0), worst.startMs));
            }
            const advance = worst.context.advance;
            const expected = worst.context.expected;
            if (advance !== undefined && expected !== undefined) {
                ev.push(evidence('Timing vs this engine’s norm',
                    ctx.fmt(advance, 1) + ' deg against a learned ' + ctx.fmt(expected, 1) +
                    ' deg for that rpm and load', worst.startMs));
            }
            if (worst.context.rpm !== undefined) {
                ev.push(evidence('Engine speed at worst event', ctx.fmt(worst.context.rpm, 0) + ' rpm', worst.startMs));
            }
            if (sustained > 0) {
                ev.push(evidence('Sustained events',
                    sustained + ' lasted over ' + ctx.fmt(KNOCK_RETARD_SUSTAINED_SECONDS, 0) + 's'));
            }

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: (sustained > 0 || worst.peakMagnitude > KNOCK_RETARD_SEVERE_DEG) ? SEVERITY.HIGH : SEVERITY.MODERATE,
                confidence: sustained > 0 ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
                summary: 'On ' + total + ' separate occasions the engine ran ' + ctx.fmt(worst.peakMagnitude, 1) +
                    ' degrees less advance than it normally uses at that same engine speed and load, with the ' +
                    'throttle steady. The comparison is against an ignition map learned from this drive, so the ' +
                    'spark map’s own load and rpm axes are accounted for, and throttle transients are excluded ' +
                    'by operating state. Without a knock-sensor channel in the log this remains a strong hint ' +
                    'rather than proof.',
                evidence: ev,
                suggestedChecks: [
                    'Try a tank of higher-octane fuel and re-log the same route',
                    'Check for carbon build-up and verify spark plug heat range and gap',
                    'Confirm intake air temperature is not inflated by heat soak',
                    'Log the knock sensor channel directly if the ECU exposes it',
                ],
                causeKey: 'knock',
            };
        },
    };

    const CAM_MIN_RPM_SPREAD = 800;

    /**
     * Variable valve timing that is not moving.
     *
     * Only the actual cam position is logged, not what the ECU asked for, so
     * this deliberately answers the one question that needs no commanded value:
     * across a whole drive covering a real spread of engine speeds, a healthy
     * cam sweeps tens of degrees. One that barely moves is stuck — a jammed oil
     * control valve, a clogged screen, or oil too thin or too low to move the
     * phaser.
     *
     * It stays quiet unless the drive actually exercised the engine, because a
     * log spent entirely at idle proves nothing about a cam that only advances
     * off idle.
     */
    const CamTimingDetector = {
        id: 'ignition.cam_stuck',
        title: 'Variable valve timing not moving',
        subSystem: SUBSYSTEM.IGNITION,
        requires: [CH.CAM_ADVANCE, CH.RPM],
        validStates: WARM_STATES,
        minEvidenceSeconds: 180,

        evaluate(summary, ctx) {
            const cam = ctx.across(CH.CAM_ADVANCE, this.validStates);
            const rpm = ctx.across(CH.RPM, this.validStates);
            if (!cam || !rpm) return null;
            if (cam.count < MIN_CELL_SAMPLES) return null;

            // Without a decent rpm spread there is no reason to expect the cam
            // to have moved, so any conclusion would be unfounded.
            const rpmSpread = rpm.quantile(0.95) - rpm.quantile(0.05);
            if (rpmSpread < CAM_MIN_RPM_SPREAD) return null;

            const span = cam.max - cam.min;
            if (span >= summary.profile.camAdvanceMinSpanDeg) return null;

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: SEVERITY.MODERATE,
                confidence: CONFIDENCE.MEDIUM,
                summary: 'Cam advance stayed within ' + ctx.fmt(span, 1) + ' degrees across the whole drive, ' +
                    'even though engine speed ranged over ' + ctx.fmt(rpmSpread, 0) + ' rpm. A working system ' +
                    'sweeps the cam by tens of degrees as load and engine speed change, so this one appears to ' +
                    'be stuck.',
                evidence: [
                    evidence('Cam advance range', ctx.fmt(cam.min, 1) + ' to ' + ctx.fmt(cam.max, 1) + ' deg'),
                    evidence('Engine speed range covered', ctx.fmt(rpmSpread, 0) + ' rpm (5th-95th pct)'),
                    evidence('Samples', String(cam.count)),
                ],
                suggestedChecks: [
                    'Check engine oil level and condition - the phaser is moved by oil pressure',
                    'Test the oil control valve and clean its filter screen',
                    'Check for cam timing fault codes stored in the ECU',
                ],
                causeKey: 'cam-timing',
            };
        },
    };

    // ── Electrical ────────────────────────────────────────────────────────

    const SUSTAINED_SAG_SECONDS = 10;

    /**
     * Charging system health.
     *
     * Separates two different faults that share a channel: a charging voltage
     * that is wrong on average (alternator or regulator), and one that is
     * mostly fine but sags (belt slip, a failing diode, or simply heavy
     * electrical load at idle). A brief dip is normal, so only a *sustained*
     * sag counts.
     */
    const ChargingSystemDetector = {
        id: 'electrical.charging',
        title: 'Charging system',
        subSystem: SUBSYSTEM.ELECTRICAL,
        requires: [CH.SYSTEM_VOLTAGE],
        validStates: STATES.filter(s => s !== ST.ENGINE_OFF),
        minEvidenceSeconds: 60,

        evaluate(summary, ctx) {
            const profile = summary.profile;
            const volts = ctx.across(CH.SYSTEM_VOLTAGE, this.validStates);
            if (!volts || volts.count < MIN_CELL_SAMPLES) return null;

            const sags = summary.events.eventsOf(EVENT_TYPES.VOLTAGE_SAG);
            const longestSag = sags.reduce((max, e) => Math.max(max, e.durationSec), 0);

            const undercharging = volts.mean < profile.chargingMinV;
            const overcharging = volts.mean > profile.chargingMaxV;
            const sustainedSag = longestSag >= SUSTAINED_SAG_SECONDS;
            if (!undercharging && !overcharging && !sustainedSag) return null;

            const title = overcharging ? 'Charging voltage too high'
                : undercharging ? 'Charging voltage low'
                : 'System voltage sagging under load';

            const text = overcharging
                ? 'System voltage averaged ' + ctx.fmt(volts.mean, 2) + 'V while running, above the ' +
                  ctx.fmt(profile.chargingMaxV, 1) + 'V limit. Overcharging boils battery electrolyte and ' +
                  'stresses electronics.'
                : undercharging
                ? 'System voltage averaged only ' + ctx.fmt(volts.mean, 2) + 'V while running, below the ' +
                  ctx.fmt(profile.chargingMinV, 1) + 'V a healthy charging system should hold. The battery is ' +
                  'not being replenished.'
                : 'System voltage held up on average (' + ctx.fmt(volts.mean, 2) + 'V) but sagged below ' +
                  ctx.fmt(profile.chargingMinV, 1) + 'V for a continuous ' + ctx.fmt(longestSag, 0) + 's, ' +
                  'dipping to ' + ctx.fmt(volts.min, 2) + 'V. Worth watching rather than alarming.';

            const ev = [
                evidence('Mean voltage running', ctx.fmt(volts.mean, 2) + 'V (' + volts.count + ' samples)'),
                evidence('Range', ctx.fmt(volts.min, 2) + 'V to ' + ctx.fmt(volts.max, 2) + 'V'),
                evidence('5th percentile', ctx.fmt(volts.quantile(0.05), 2) + 'V'),
            ];
            if (sags.length > 0) {
                const worst = sags.reduce((a, b) => (b.durationSec > a.durationSec ? b : a));
                ev.push(evidence('Longest sag',
                    ctx.fmt(worst.durationSec, 1) + 's', worst.startMs));
            }

            return {
                detectorId: this.id,
                title,
                subSystem: this.subSystem,
                severity: (overcharging || undercharging) ? SEVERITY.HIGH : SEVERITY.LOW,
                confidence: (overcharging || undercharging) ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
                summary: text,
                evidence: ev,
                suggestedChecks: [
                    'Measure charging voltage at the battery terminals at idle and at 2000 rpm',
                    'Check the alternator belt tension and the main charging cable and grounds',
                    'Load-test the battery',
                ],
                causeKey: 'charging',
            };
        },
    };

    // ── Idle and air ──────────────────────────────────────────────────────

    const IACV_SATURATION_PCT = 95;

    /**
     * Unstable idle.
     *
     * Measures short-window roughness rather than the spread of idle speed over
     * the whole log. The distinction matters: a car that idles at 800 rpm cold
     * and 700 rpm warm has a wide spread and a perfectly steady idle. Roughness
     * is computed inside a one-second window, so slow drift and legitimate
     * idle-up cancel out and only genuine hunting survives.
     */
    const IdleQualityDetector = {
        id: 'idle.unstable',
        title: 'Unstable idle',
        subSystem: SUBSYSTEM.IDLE,
        requires: [CH.RPM],
        validStates: [ST.IDLE_WARM],
        minEvidenceSeconds: 60,

        evaluate(summary, ctx) {
            const roughness = ctx.across(CH.RPM_ROUGHNESS, [ST.IDLE_WARM]);
            if (!roughness || roughness.count < MIN_CELL_SAMPLES) return null;
            if (roughness.mean < summary.profile.idleRpmStdevMax) return null;

            const rpm = ctx.across(CH.RPM, [ST.IDLE_WARM]);
            const iacv = summary.isUsable(CH.IACV) ? ctx.across(CH.IACV, [ST.IDLE_WARM]) : null;
            const iacvSaturated = !!iacv && iacv.max >= IACV_SATURATION_PCT;

            let text = 'At warm idle the engine speed wanders by ' + ctx.fmt(roughness.mean, 0) + ' rpm within a ' +
                'one-second window, above the ' + ctx.fmt(summary.profile.idleRpmStdevMax, 0) + ' rpm threshold. ';
            text += iacvSaturated
                ? 'The idle air valve also reached ' + ctx.fmt(iacv.max, 0) + '%, meaning the ECU ran out of ' +
                  'authority trying to hold idle - it is compensating for something.'
                : 'Rough roads and accessory loads can inflate this, so treat it as a lead rather than a fault.';

            const ev = [evidence('Idle roughness',
                ctx.fmt(roughness.mean, 0) + ' rpm (1s window, ' + roughness.count + ' samples)')];
            if (rpm) {
                ev.push(evidence('Idle speed',
                    ctx.fmt(rpm.mean, 0) + ' rpm, range ' + ctx.fmt(rpm.min, 0) + '-' + ctx.fmt(rpm.max, 0)));
            }
            if (iacv) {
                ev.push(evidence('Idle air valve',
                    'mean ' + ctx.fmt(iacv.mean, 1) + '%, peak ' + ctx.fmt(iacv.max, 1) + '%'));
            }

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: SEVERITY.MODERATE,
                confidence: iacvSaturated ? CONFIDENCE.MEDIUM : CONFIDENCE.LOW,
                summary: text,
                evidence: ev,
                suggestedChecks: [
                    'Clean the throttle body and idle air control valve',
                    'Check for vacuum leaks, which the idle control has to fight',
                    'Inspect spark plugs and coils for a weak cylinder',
                    'Check engine and gearbox mounts if the wobble is felt rather than heard',
                ],
                causeKey: 'idle',
            };
        },
    };

    const HEATSOAK_RISE_C = 25;

    /**
     * Intake heat soak.
     *
     * Uses the coldest intake temperature in the log as an ambient reference.
     * That is a proxy, not a measurement — it is only sound when the log starts
     * cold — so the finding is informational and says what it assumed.
     */
    const IntakeHeatSoakDetector = {
        id: 'air.intake_heatsoak',
        title: 'Intake air heat soak',
        subSystem: SUBSYSTEM.AIR,
        requires: [CH.INTAKE_AIR_TEMP],
        validStates: [ST.CRUISE_STEADY],
        minEvidenceSeconds: 120,

        evaluate(summary, ctx) {
            const cruise = ctx.across(CH.INTAKE_AIR_TEMP, [ST.CRUISE_STEADY]);
            if (!cruise || cruise.count < MIN_CELL_SAMPLES) return null;

            // A real measurement when one is available, an inference otherwise -
            // and the report says which, because the difference matters to
            // anyone deciding whether to act on it.
            const supplied = summary.profile.ambientC;
            const measured = (supplied !== null && supplied !== undefined && !Number.isNaN(supplied));
            const ambient = measured ? supplied : summary.timeline.ambientEstimateC;
            // Too short to have held any temperature long enough to judge.
            if (ambient === null || ambient === undefined || Number.isNaN(ambient)) return null;

            const rise = cruise.mean - ambient;
            if (rise < HEATSOAK_RISE_C) return null;

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: SEVERITY.LOW,
                confidence: CONFIDENCE.LOW,
                summary: 'Intake air averaged ' + ctx.fmt(cruise.mean, 1) + ' degC while cruising, ' +
                    ctx.fmt(rise, 1) + ' degC above ' +
                    (measured
                        ? 'the outside air temperature (' + ctx.fmt(ambient, 1) + ' degC). '
                        : 'the coolest the intake ever settled at (' + ctx.fmt(ambient, 1) +
                          ' degC, standing in for outside air). ') +
                    'Hot intake air costs power and makes the engine more knock-prone, so it is worth ruling ' +
                    'out before chasing ignition faults.',
                evidence: [
                    evidence('Mean intake air, cruising', ctx.fmt(cruise.mean, 1) + ' degC'),
                    evidence('Peak intake air', ctx.fmt(cruise.max, 1) + ' degC'),
                    measured
                        ? evidence('Outside air', ctx.fmt(ambient, 1) + ' degC (from the vehicle profile)')
                        : evidence('Assumed ambient', ctx.fmt(ambient, 1) + ' degC (lowest intake temperature ' +
                            'held for ' + AMBIENT_WINDOW_SECONDS + 's or more)'),
                ],
                suggestedChecks: [
                    'Check for hot air being drawn from the engine bay rather than outside',
                    'Inspect intake heat shielding',
                    'On a forced-induction engine, check intercooler airflow and for a blocked core',
                ],
                causeKey: 'intake-temp',
            };
        },
    };

    // ── Sensors ───────────────────────────────────────────────────────────

    /** Channels the engine cannot run properly without, so a frozen value is a real fault. */
    const CORE_CHANNELS = new Set([
        CH.RPM, CH.COOLANT_TEMP, CH.ENGINE_LOAD, CH.MAF,
        CH.TPS, CH.INTAKE_AIR_TEMP, CH.VEHICLE_SPEED, CH.LAMBDA_INT_1,
    ]);

    /**
     * A sensor that is present in the log but not behaving like a sensor.
     *
     * Deliberately declares no required channels: it is the one detector that
     * must inspect channel health directly, because the framework's own health
     * gate would otherwise skip it for exactly the channels it exists to report
     * on.
     *
     * The core/auxiliary split is the important part. In the reference log five
     * analog inputs sit at a constant voltage because nothing is wired to them
     * — reporting those as dead sensors would be five false alarms on a healthy
     * car. A constant reading only means something on a channel the engine
     * genuinely depends on.
     */
    const StuckSensorDetector = {
        id: 'sensors.suspect',
        title: 'Sensor reading looks wrong',
        subSystem: SUBSYSTEM.SENSORS,
        requires: [],
        validStates: STATES,
        minEvidenceSeconds: 0,

        evaluate(summary, ctx) {
            const suspect = [...summary.channelHealth.values()].filter(health =>
                CORE_CHANNELS.has(health.channel) &&
                (health.status === STATUS_CONSTANT || health.status === STATUS_IMPLAUSIBLE));
            if (suspect.length === 0) return null;

            const text = suspect.map(health =>
                health.status === STATUS_CONSTANT
                    ? health.channel.displayName + ' never changed from ' + ctx.fmt(health.min, 2) + ' ' +
                      health.channel.unit + ' across the whole log.'
                    : health.channel.displayName + ' spent ' + ctx.fmt(health.outOfRangeFraction * 100, 0) +
                      '% of the log outside physically plausible values.'
            ).join(' ') + ' Any diagnosis depending on these channels was skipped.';

            return {
                detectorId: this.id,
                title: this.title,
                subSystem: this.subSystem,
                severity: SEVERITY.HIGH,
                confidence: CONFIDENCE.HIGH,
                summary: text,
                evidence: suspect.map(health => evidence(
                    health.channel.displayName,
                    health.status + ': ' + ctx.fmt(health.min, 2) + ' to ' + ctx.fmt(health.max, 2) + ' ' +
                    health.channel.unit,
                )),
                suggestedChecks: [
                    'Check the wiring and connector for the affected sensor',
                    "Compare the sensor's reading against a known-good reference",
                    'Confirm the logger is actually subscribed to that channel',
                ],
                causeKey: 'sensor',
            };
        },
    };

    /**
     * The shipped rule set.
     *
     * Order here is irrelevant — findings are ranked by severity and confidence
     * afterwards, never by registration order. Adding a diagnosis means adding
     * one object to this list.
     */
    const BUILT_IN_DETECTORS = [
        // Fuel and mixture
        VacuumLeakDetector,
        FuelSupplyDetector,
        RichMixtureDetector,
        BankImbalanceDetector,
        // Cooling
        OverheatDetector,
        ThermostatStuckOpenDetector,
        CoolantFlowDetector,
        // Ignition
        KnockCorrectionDetector,
        KnockRetardDetector,
        CamTimingDetector,
        // Electrical
        ChargingSystemDetector,
        // Idle and air
        IdleQualityDetector,
        IntakeHeatSoakDetector,
        // Sensors
        StuckSensorDetector,
    ];

    /**
     * Runs detectors, enforcing preconditions uniformly.
     *
     * Both gates live here rather than inside each rule on purpose. A
     * per-detector evidence check is a thing an author forgets, and one
     * forgotten check is a false positive shipped to a user.
     */
    function runDetectors(summary, detectors) {
        const ctx = new DetectorContext(summary);
        const findings = [];
        const skipped = [];

        for (const detector of detectors) {
            const missing = detector.requires.filter(c => !summary.isUsable(c));
            if (missing.length > 0) {
                skipped.push({
                    detectorId: detector.id,
                    title: detector.title,
                    reason: missing.map(channel => {
                        const health = summary.channelHealth.get(channel);
                        return channel.displayName + ' ' + (health ? health.status : STATUS_ABSENT);
                    }).join(', '),
                    missingChannels: missing,
                });
                continue;
            }

            const superseded = (detector.skipWhenPresent || []).filter(c => summary.isUsable(c));
            if (superseded.length > 0) {
                skipped.push({
                    detectorId: detector.id,
                    title: detector.title,
                    reason: 'superseded by a direct measurement: ' +
                        superseded.map(c => c.displayName).join(', '),
                    missingChannels: [],
                });
                continue;
            }

            const seconds = ctx.secondsIn(detector.validStates);
            if (seconds < detector.minEvidenceSeconds) {
                skipped.push({
                    detectorId: detector.id,
                    title: detector.title,
                    reason: 'only ' + seconds.toFixed(0) + 's of relevant driving (needs ' +
                        detector.minEvidenceSeconds.toFixed(0) + 's)',
                    missingChannels: [],
                });
                continue;
            }

            try {
                const finding = detector.evaluate(summary, ctx);
                if (finding) findings.push(finding);
            } catch (error) {
                skipped.push({
                    detectorId: detector.id,
                    title: detector.title,
                    reason: 'detector error: ' + (error && error.message),
                    missingChannels: [],
                });
            }
        }

        return { findings, skipped, summary };
    }

    // ══════════════════════════════════════════════════════════════════════
    // 6. Rank
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Groups findings by root cause and orders them.
     *
     * Grouping exists because a single fault trips several detectors. A vacuum
     * leak shows up as lean trim at low load, an unstable idle, and a saturated
     * idle air valve. Listing three findings invites three repairs; listing one
     * cause with three pieces of evidence is the actual diagnosis.
     */
    function rankReport(report) {
        const summary = report.summary;

        const bySeverityThenConfidence = (a, b) =>
            (b.severity.rank - a.severity.rank) || (b.confidence.rank - a.confidence.rank);

        const byCause = new Map();
        for (const finding of report.findings) {
            const key = finding.causeKey || finding.detectorId;
            if (!byCause.has(key)) byCause.set(key, []);
            byCause.get(key).push(finding);
        }

        const groups = [...byCause.values()].map(findings => {
            const ordered = findings.slice().sort(bySeverityThenConfidence);
            const primary = ordered[0];
            const related = ordered.slice(1);
            return {
                primary, related,
                severity: primary.severity,
                all: [primary].concat(related),
            };
        }).sort((a, b) =>
            (b.primary.severity.rank - a.primary.severity.rank) ||
            (b.primary.confidence.rank - a.primary.confidence.rank) ||
            (b.all.length - a.all.length));

        const stateBreakdown = [...summary.stateSeconds.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([state, seconds]) => ({ state, seconds }));

        let samplesAnalyzed = 0;
        for (const cell of summary.byState.values()) samplesAnalyzed += cell.samples;

        const overview = {
            durationSeconds: summary.readStats.durationMs / 1000,
            runningSeconds: summary.timeline.runningSeconds,
            rowsRead: summary.readStats.rowsRead,
            rowsMalformed: summary.readStats.rowsMalformed,
            samplesAnalyzed,
            channelsRecognized: summary.readStats.header.channels.size,
            unmappedColumns: summary.readStats.header.unmapped,
            stateBreakdown,
            unusableChannels: [...summary.channelHealth.values()]
                .filter(h => !h.usable && h.samples > 0)
                .map(h => h.channel),
            staleSeconds: staleSeconds(summary.staleSpans || []),
            staleSpanCount: (summary.staleSpans || []).length,
        };

        return {
            groups,
            skipped: report.skipped,
            overview,
            summary,
            get worstSeverity() { return this.groups.length ? this.groups[0].severity : null; },
            get isClean() { return this.groups.every(g => g.severity.rank < SEVERITY.MODERATE.rank); },
        };
    }

    // ── Plain-text rendering, for sharing a report as text ────────────────

    function mmss(seconds) {
        const s = Math.trunc(seconds);
        return Math.trunc(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function wrapText(text, width, indent) {
        const out = [];
        let line = '';
        for (const word of text.split(' ')) {
            if (line && line.length + word.length + 1 > width) { out.push(indent + line); line = ''; }
            line = line ? line + ' ' + word : word;
        }
        if (line) out.push(indent + line);
        return out.join('\n');
    }

    const SEVERITY_BADGE = {
        CRITICAL: 'CRITICAL', HIGH: 'HIGH    ', MODERATE: 'MODERATE',
        LOW: 'MINOR   ', INFO: 'INFO    ',
    };

    function renderTextReport(report) {
        const o = report.overview;
        const lines = [];
        const rule = ch => ch.repeat(78);

        lines.push(rule('='));
        lines.push('ENGINE LOG DIAGNOSIS');
        lines.push(rule('='));
        lines.push('Log duration      : ' + mmss(o.durationSeconds) +
            ' (' + (o.runningSeconds / 60).toFixed(1) + ' min running)');
        lines.push('Rows read         : ' + o.rowsRead);
        lines.push('Samples analysed  : ' + o.samplesAnalyzed + ' (after resampling)');
        lines.push('Channels used     : ' + o.channelsRecognized);
        if (o.unmappedColumns.length) {
            lines.push('Unrecognised cols : ' + o.unmappedColumns.join(', '));
        }
        if (o.unusableChannels.length) {
            lines.push('Unusable channels : ' + o.unusableChannels.map(c => c.displayName).join(', '));
        }
        if (o.staleSeconds > 0) {
            lines.push('Frozen feed       : ' + o.staleSeconds.toFixed(1) + 's excluded in ' +
                o.staleSpanCount + ' stretch(es) - the logger was repeating stale values');
        }
        lines.push('');
        lines.push('Time in each operating state:');
        for (const { state, seconds } of o.stateBreakdown) {
            if (seconds < 0.5) continue;
            const pct = o.durationSeconds > 0 ? seconds / o.durationSeconds * 100 : 0;
            lines.push('  ' + state.label.padEnd(22) + seconds.toFixed(1).padStart(7) + 's  ' +
                pct.toFixed(1).padStart(5) + '%');
        }
        lines.push('');

        if (report.groups.length === 0) {
            lines.push('No faults detected.');
        } else {
            lines.push(rule('-'));
            lines.push('FINDINGS (' + report.groups.length + ')');
            lines.push(rule('-'));
            report.groups.forEach((group, index) => {
                const f = group.primary;
                lines.push('');
                lines.push((index + 1) + '. [' + SEVERITY_BADGE[f.severity.name] + '] ' + f.title);
                lines.push('   ' + f.subSystem + ' | confidence: ' + f.confidence.label + ' | rule: ' + f.detectorId);
                lines.push('');
                lines.push(wrapText(f.summary, 74, '   '));
                lines.push('');
                lines.push('   Evidence:');
                for (const e of f.evidence) {
                    const at = e.timeMs !== null && e.timeMs !== undefined ? ' (at ' + mmss(e.timeMs / 1000) + ')' : '';
                    lines.push('     - ' + e.label + ': ' + e.value + at);
                }
                if (f.suggestedChecks.length) {
                    lines.push('   Suggested checks:');
                    for (const c of f.suggestedChecks) lines.push('     - ' + c);
                }
                for (const related of group.related) {
                    lines.push('   Also consistent with this cause: ' + related.title + ' (' + related.detectorId + ')');
                }
            });
        }

        if (report.skipped.length) {
            lines.push('');
            lines.push(rule('-'));
            lines.push('NOT CHECKED (' + report.skipped.length + ')');
            lines.push(rule('-'));
            lines.push('These are absences of evidence, not clean bills of health.');
            for (const s of report.skipped) lines.push('  - ' + s.title + ': ' + s.reason);
        }

        return lines.join('\n') + '\n';
    }

    // ══════════════════════════════════════════════════════════════════════
    // Pipeline
    // ══════════════════════════════════════════════════════════════════════

    /**
     * Ingest -> condition -> segment -> aggregate -> detect -> rank.
     *
     * The text is read twice. The first pass learns the engine's own ignition
     * map and the closed-throttle reference; the second judges timing against
     * them. That baseline cannot exist until the whole log has been seen, and
     * the alternative — buffering the conditioned samples — is precisely the
     * thing that must not scale with drive length.
     *
     * @param text     the whole CSV as a string.
     * @param options  { profile, detectors, onProgress } — onProgress receives
     *                 0..1 across both passes.
     */
    function analyze(text, options) {
        const opts = options || {};
        const profile = opts.profile || DEFAULT_PROFILE;
        const detectors = opts.detectors || BUILT_IN_DETECTORS;
        const onProgress = opts.onProgress || null;

        const runPass = (calibration, scale) => {
            const health = new ChannelHealthTracker();
            const resampler = new Resampler(resampleIntervalMs(profile));
            const segmenter = new StateSegmenter(profile, calibration ? calibration.closedThrottlePct : null);
            const builder = new SummaryBuilder(profile, calibration ? calibration.sparkMap : null);

            // A frozen feed can only be recognised after it has been frozen for
            // a while, so pass 1 maps the stale stretches and pass 2 drops them.
            // Two passes already exist for the spark map; this rides along.
            //
            // Pass 1 therefore still learns from the frozen samples, which is
            // benign rather than merely tolerable: a frozen value is a repeat of
            // the last genuine reading, so it lands in the cell that reading
            // already belonged to and pulls a median toward a value that was
            // already typical there. Freezing 90 s inside a hard pull - the worst
            // case, since that cell is one the knock rule actually consults -
            // moves the learned baseline by 0.004 degrees.
            const tracker = calibration ? null : new StaleFeedTracker();
            const spans = calibration ? calibration.staleSpans : [];
            const isStale = staleFilter(spans);

            const readStats = readCsv(text, sample => {
                if (tracker) tracker.observe(sample);
                // Dropped outright rather than marked: a repeated value is not a
                // measurement, so it must not reach the health tracker either,
                // where it would make a live channel look dead. The time jump
                // this leaves behind is handled exactly like a logging pause.
                if (isStale(sample.timeMs)) return;

                // Health is judged on the raw signal. A channel that is constant
                // in the file must not be rescued by the resampler's averaging,
                // and one that is noisy must not be blamed on it.
                for (const channel of CHANNELS) {
                    const value = sample.values[channel.ordinal];
                    if (!Number.isNaN(value)) health.observe(channel, value);
                }
                resampler.push(sample, resampled => builder.accept(segmenter.analyze(resampled)));
            }, {
                onProgress: onProgress ? fraction => onProgress(scale(fraction)) : null,
            });
            resampler.flush(resampled => builder.accept(segmenter.analyze(resampled)));

            return {
                summary: builder.build(readStats, health.finish(), spans),
                calibration: Object.assign(builder.calibration(), {
                    staleSpans: tracker ? tracker.finish() : spans,
                }),
            };
        };

        // Pass 1: learn the ignition baseline and the closed-throttle reference.
        // Neither can be known before the whole log has been read, so no
        // knock-retard events are produced here.
        const pass1 = runPass(null, f => f * 0.5);

        // Pass 2: same arithmetic, now able to judge timing against the
        // engine's own map and to recognise a closed throttle on a vehicle
        // whose sensor does not rest at zero.
        const pass2 = runPass(pass1.calibration, f => 0.5 + f * 0.5);
        if (onProgress) onProgress(1);

        return rankReport(runDetectors(pass2.summary, detectors));
    }


    /**
     * Reduces a ranked report to a plain, JSON-safe object.
     *
     * The full report holds class instances, Maps and accessors — none of which
     * survive a structured clone intact, and none of which the UI needs. This
     * is the view that crosses the Worker boundary and the one the renderer
     * draws from, so display code never reaches into pipeline internals.
     */
    function toPlainReport(report) {
        const plainFinding = f => ({
            detectorId: f.detectorId,
            title: f.title,
            subSystem: f.subSystem,
            severity: { name: f.severity.name, label: f.severity.label, rank: f.severity.rank },
            confidence: { name: f.confidence.name, label: f.confidence.label, rank: f.confidence.rank },
            summary: f.summary,
            evidence: f.evidence.map(e => ({ label: e.label, value: e.value, timeMs: e.timeMs })),
            suggestedChecks: f.suggestedChecks.slice(),
            causeKey: f.causeKey || null,
        });

        const o = report.overview;
        return {
            overview: {
                durationSeconds: o.durationSeconds,
                runningSeconds: o.runningSeconds,
                rowsRead: o.rowsRead,
                rowsMalformed: o.rowsMalformed,
                samplesAnalyzed: o.samplesAnalyzed,
                channelsRecognized: o.channelsRecognized,
                unmappedColumns: o.unmappedColumns.slice(),
                unusableChannels: o.unusableChannels.map(c => ({
                    name: c.name, displayName: c.displayName, unit: c.unit,
                })),
                stateBreakdown: o.stateBreakdown.map(e => ({
                    name: e.state.name, label: e.state.label, seconds: e.seconds,
                })),
                staleSeconds: o.staleSeconds,
                staleSpanCount: o.staleSpanCount,
            },
            groups: report.groups.map(g => ({
                primary: plainFinding(g.primary),
                related: g.related.map(plainFinding),
            })),
            skipped: report.skipped.map(s => ({
                detectorId: s.detectorId, title: s.title, reason: s.reason,
            })),
            isClean: report.isClean,
            text: renderTextReport(report),
        };
    }

    return {
        analyze,
        renderTextReport,
        toPlainReport,
        // Exported for the test suite and for anyone extending the rule set.
        CHANNELS, CH, STATES, ST, LOAD_BINS, LB, RPM_BINS,
        SEVERITY, CONFIDENCE, SUBSYSTEM, EVENT_TYPES,
        STATUS_OK, STATUS_ABSENT, STATUS_CONSTANT, STATUS_IMPLAUSIBLE,
        DEFAULT_PROFILE, makeProfile, resampleIntervalMs,
        Sample, emptyValues, Resampler, ChannelHealthTracker, StateSegmenter,
        Accum, mergeAccums, ChannelStats, SparkMap, EventCollector, SummaryBuilder,
        StaleFeedTracker, staleFilter, staleSeconds, SustainedMinTracker,
        DetectorContext, BUILT_IN_DETECTORS, runDetectors, rankReport,
        readCsv, resolveChannel, aliasRank, normalizeHeader,
        rpmBinOf, loadBinOf,
    };
}));
