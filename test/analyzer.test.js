// Ported from the Car Doctor Kotlin test suite. Every assertion here was
// written against the original pipeline; keeping them is what proves the
// JavaScript port behaves the same way.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const CarDoctor = require('../analyzer.js');
const { SyntheticLog, HEADER } = require('./synthetic-log.js');

const {
    CH, ST, SEVERITY, CONFIDENCE, EVENT_TYPES,
    STATUS_OK, STATUS_ABSENT, STATUS_CONSTANT,
    Sample, emptyValues, Resampler, ChannelHealthTracker, StateSegmenter,
    Accum, mergeAccums, EventCollector, DEFAULT_PROFILE,
    resolveChannel, readCsv, analyze,
} = CarDoctor;

// ── Helpers ──────────────────────────────────────────────────────────────

const run = (log, profile) => analyze(log.build(), profile ? { profile } : undefined);
const has = (report, detectorId) =>
    report.groups.some(g => g.all.some(f => f.detectorId === detectorId));
const finding = (report, detectorId) =>
    report.groups.flatMap(g => g.all).find(f => f.detectorId === detectorId) || null;
const titles = report => report.groups.map(g => g.primary.title).join(', ');

// ── Channel resolution ───────────────────────────────────────────────────

test('channel aliases resolve across logger naming conventions', () => {
    for (const header of ['engine speed (RPM)', 'Engine Speed', 'RPM', 'engine_speed', '  rpm  ']) {
        assert.strictEqual(resolveChannel(header), CH.RPM, `failed on '${header}'`);
    }
    assert.strictEqual(resolveChannel('lambda int 1 (%)'), CH.LAMBDA_INT_1);
    assert.strictEqual(resolveChannel('Coolant Temp (degC)'), CH.COOLANT_TEMP);
});

test('the derived roughness channel can never be matched from a file header', () => {
    // It has no aliases by construction; a log column must never claim it.
    assert.notStrictEqual(resolveChannel('engine speed roughness'), CH.RPM_ROUGHNESS);
    assert.strictEqual(resolveChannel('rpm roughness'), null);
});

// ── Resampling ───────────────────────────────────────────────────────────

function rpmSample(timeMs, rpm) {
    const values = emptyValues();
    values[CH.RPM.ordinal] = rpm;
    return new Sample(timeMs, values);
}

test('irregular input becomes a uniform grid', () => {
    const out = [];
    const resampler = new Resampler(200);
    // Deliberately uneven spacing, as a real logger produces.
    [0, 60, 130, 190, 260, 310, 400, 480, 550, 610].forEach((t, i) => {
        resampler.push(rpmSample(t, 1000 + i * 10), s => out.push(s));
    });
    resampler.flush(s => out.push(s));

    assert.ok(out.length >= 3, `expected several grid slots, got ${out.length}`);
    const spacings = out.slice(1).map((s, i) => s.timeMs - out[i].timeMs);
    assert.ok(spacings.every(s => s === 200), `grid must be uniform, got ${spacings}`);
});

test('a knock correction keeps its peak instead of being averaged away', () => {
    const out = [];
    const resampler = new Resampler(200);
    // One hard correction among mild neighbours, all inside a single slot.
    [-0.38, -5.62, -0.38, 0.0].forEach((value, i) => {
        const values = emptyValues();
        values[CH.KNOCK_CORRECTION.ordinal] = value;
        values[CH.RPM.ordinal] = 2000;
        resampler.push(new Sample(i * 40, values), s => out.push(s));
    });
    resampler.flush(s => out.push(s));

    const worst = Math.min(...out.map(s => s.get(CH.KNOCK_CORRECTION)));
    assert.ok(Math.abs(worst - (-5.62)) < 1e-9,
        'averaging would report about -1.6 and understate how hard the engine knocked');
    // Ordinary channels are still averaged.
    assert.ok(Math.abs(out[0].get(CH.RPM) - 2000) < 1e-9);
});

test('a long gap is not filled with invented samples', () => {
    const out = [];
    const resampler = new Resampler(200, 2000);
    resampler.push(rpmSample(0, 900), s => out.push(s));
    resampler.push(rpmSample(200, 900), s => out.push(s));
    // Engine off for five minutes, then running again.
    resampler.push(rpmSample(300000, 900), s => out.push(s));
    resampler.flush(s => out.push(s));

    // 300 s at 200 ms would be 1500 carried-forward samples if the gap were filled.
    assert.ok(out.length < 10, `gap must not be interpolated, got ${out.length} samples`);
});

// ── Event coalescing ─────────────────────────────────────────────────────

test('consecutive matching samples collapse into one occurrence', () => {
    const collector = new EventCollector(3000);
    // One two-second physical event, sampled at 5 Hz: ten consecutive hits.
    for (let i = 0; i < 10; i++) collector.record(EVENT_TYPES.KNOCK_RETARD, i * 200, 8 + i);
    assert.strictEqual(collector.countOf(EVENT_TYPES.KNOCK_RETARD), 1);

    const events = collector.eventsOf(EVENT_TYPES.KNOCK_RETARD);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].sampleCount, 10);
    assert.ok(Math.abs(events[0].peakMagnitude - 17) < 1e-9, 'peak must survive coalescing');
});

test('occurrences separated by more than the dead time stay distinct', () => {
    const collector = new EventCollector(3000);
    collector.record(EVENT_TYPES.KNOCK_RETARD, 0, 8);
    collector.record(EVENT_TYPES.KNOCK_RETARD, 10000, 9);
    collector.record(EVENT_TYPES.KNOCK_RETARD, 20000, 7);
    assert.strictEqual(collector.countOf(EVENT_TYPES.KNOCK_RETARD), 3);
});

// ── Accumulator merging ──────────────────────────────────────────────────

test('merging cells gives the same answer as accumulating them together', () => {
    const values = [];
    for (let i = 1; i <= 500; i++) values.push((i * 0.37) % 40 - 20);

    const direct = new Accum(CH.LAMBDA_INT_1);
    values.forEach(v => direct.add(v));

    const parts = [];
    for (let i = 0; i < values.length; i += 70) {
        const part = new Accum(CH.LAMBDA_INT_1);
        values.slice(i, i + 70).forEach(v => part.add(v));
        parts.push(part);
    }
    const merged = mergeAccums(CH.LAMBDA_INT_1, parts);

    assert.strictEqual(merged.count, direct.count);
    assert.ok(Math.abs(merged.mean - direct.mean) < 1e-9, 'merged mean must be exact');
    assert.ok(Math.abs(merged.stdev - direct.stdev) < 1e-9, 'merged variance must be exact');
    assert.ok(Math.abs(merged.min - direct.min) < 1e-9);
    assert.ok(Math.abs(merged.max - direct.max) < 1e-9);
    assert.ok(Math.abs(merged.median - direct.median) < 1e-9, 'histograms must add bucket-wise');
});

// ── Channel health ───────────────────────────────────────────────────────

test('an unwired constant input is reported as constant, not as a valid reading', () => {
    const tracker = new ChannelHealthTracker();
    for (let i = 0; i < 500; i++) tracker.observe(CH.TPS, 3.148);
    for (let i = 0; i < 500; i++) tracker.observe(CH.RPM, 800 + (i % 13));
    const health = tracker.finish();

    assert.strictEqual(health.get(CH.TPS).status, STATUS_CONSTANT);
    assert.strictEqual(health.get(CH.RPM).status, STATUS_OK);
    assert.strictEqual(health.get(CH.OIL_TEMP).status, STATUS_ABSENT);
});

// ── Segmentation ─────────────────────────────────────────────────────────

function driveSample(timeMs, rpm, load, tps, speed, coolant) {
    const v = emptyValues();
    v[CH.RPM.ordinal] = rpm;
    v[CH.ENGINE_LOAD.ordinal] = load;
    v[CH.TPS.ordinal] = tps;
    v[CH.VEHICLE_SPEED.ordinal] = speed;
    v[CH.COOLANT_TEMP.ordinal] = coolant;
    return new Sample(timeMs, v);
}

test('a throttle sensor stuck at zero does not turn cruising into overrun', () => {
    // Regression test for a real defect found against the reference log. That
    // car's throttle reads exactly 0.0% for three quarters of all moving
    // samples while the engine is plainly making power; treating "throttle
    // closed" as sufficient evidence of overrun misfiled a third of the drive.
    const segmenter = new StateSegmenter(DEFAULT_PROFILE);
    let cruise = 0, overrun = 0;
    for (let i = 0; i < 200; i++) {
        // Load of 95 mg/str: the engine is working. Throttle reads zero anyway.
        const analyzed = segmenter.analyze(driveSample(i * 200, 1600, 95, 0, 50, 92));
        if (analyzed.state === ST.CRUISE_STEADY) cruise++;
        if (analyzed.state === ST.DECEL_OVERRUN) overrun++;
    }
    assert.strictEqual(overrun, 0, 'load says the engine is making power - this is not overrun');
    assert.ok(cruise > 150, `expected steady cruise, got ${cruise} of 200`);
});

test('genuine closed-throttle overrun is still recognised', () => {
    const segmenter = new StateSegmenter(DEFAULT_PROFILE);
    let overrun = 0;
    for (let i = 0; i < 200; i++) {
        // Same closed throttle, but load has collapsed: this really is overrun.
        const analyzed = segmenter.analyze(driveSample(i * 200, 1600, 60, 0, 50, 92));
        if (analyzed.state === ST.DECEL_OVERRUN) overrun++;
    }
    assert.ok(overrun > 150, `expected overrun, got ${overrun} of 200`);
});

// ── Whole-pipeline behaviour ─────────────────────────────────────────────

test('healthy drive produces no significant findings', () => {
    const report = run(new SyntheticLog().healthyDrive());
    const significant = report.groups.filter(g => g.severity.rank >= SEVERITY.MODERATE.rank);
    assert.strictEqual(significant.length, 0,
        'expected a clean bill of health, got: ' + significant.map(g => g.primary.title).join(', '));
});

test('vacuum leak is detected from the shape of trim across load', () => {
    // A fixed air leak is a large fraction of a small airflow and a negligible
    // fraction of a large one, so the correction fades as load rises.
    const leak = load => Math.min(16, 14 * (100 / load));
    const report = run(new SyntheticLog()
        .phase({ seconds: 200, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, trimAtLoad: leak })
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, trimAtLoad: leak })
        .phase({ seconds: 200, rpm: 3600, load: 480, tps: 75, speed: 120, coolant: 95, trimAtLoad: leak }));

    assert.ok(has(report, 'fuel.unmetered_air'), 'expected a vacuum leak finding, got: ' + titles(report));
    // The converging shape must not be mistaken for a uniform fuelling shortfall.
    assert.ok(!has(report, 'fuel.supply_shortfall'));
});

test('uniform enrichment reads as a fuel supply problem, not a leak', () => {
    const starved = () => 15;
    const report = run(new SyntheticLog()
        .phase({ seconds: 200, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, trimAtLoad: starved })
        .phase({ seconds: 400, rpm: 2200, load: 300, tps: 30, speed: 70, coolant: 92, trimAtLoad: starved })
        .phase({ seconds: 300, rpm: 3600, load: 480, tps: 75, speed: 120, coolant: 95, trimAtLoad: starved }));

    assert.ok(has(report, 'fuel.supply_shortfall'), 'expected a fuel supply finding, got: ' + titles(report));
    assert.ok(!has(report, 'fuel.unmetered_air'), 'a flat trim across load is not a vacuum leak');
});

test('overheating is reported as critical', () => {
    const report = run(new SyntheticLog()
        .phase({ seconds: 300, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 95 })
        .phase({ seconds: 200, rpm: 2200, load: 200, tps: 20, speed: 70, coolant: 118 }));

    const f = finding(report, 'cooling.overheat');
    assert.ok(f, 'expected an overheat finding');
    assert.strictEqual(f.severity, SEVERITY.CRITICAL);
});

test('undercharging is detected', () => {
    const report = run(new SyntheticLog()
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 12.2 }));
    assert.ok(has(report, 'electrical.charging'));
});

test('a normal spark map is not reported as knock', () => {
    // Advance falls steeply with load here, exactly as a real map does. A
    // detector comparing advance against its own recent past would call this
    // knock; comparing against the learned per-operating-point baseline must not.
    const report = run(new SyntheticLog()
        .phase({ seconds: 200, rpm: 1500, load: 100, tps: 5, speed: 40, coolant: 92, advance: 34 })
        .phase({ seconds: 200, rpm: 2000, load: 300, tps: 30, speed: 80, coolant: 92, advance: 34 })
        .phase({ seconds: 200, rpm: 2600, load: 500, tps: 70, speed: 110, coolant: 92, advance: 34 }));

    assert.ok(!has(report, 'ignition.knock_retard'),
        'spark map following its load axis must not be reported as knock');
});

test('detectors are skipped rather than guessed when a channel is missing', () => {
    const lines = ['Timestamp (ms),engine speed (RPM),coolant temp (C)'];
    for (let i = 0; i < 400; i++) lines.push(`${i * 66},${820 + i % 7},${(92 + (i % 5) * 0.25).toFixed(2)}`);
    const report = analyze(lines.join('\n') + '\n');

    const skipped = report.skipped.find(s => s.detectorId === 'fuel.unmetered_air');
    assert.ok(skipped, 'a detector missing its channels must be reported as skipped');
    assert.ok(skipped.reason.includes('absent'), 'skip reason should name the missing channel');
    // No mixture finding may be invented from a log carrying no mixture data.
    assert.ok(!has(report, 'fuel.unmetered_air'));
    assert.ok(!has(report, 'fuel.supply_shortfall'));
});

// ── RomRaider logs ───────────────────────────────────────────────────────

const ROMRAIDER_HEADER =
    'Time (msec),..ECT (°C),..IAT (°C),..IGN (°BTDC),..IPW (ms),..Knock (° Cor),' +
    '..Load (mg/stroke),..MAF (kg/h),..RPM (RPM),..TPS (%),.IACV (%),.IACV_AlphaN (%),' +
    '.STFT1 (%),.STFT2 (%),.VANOS (KW °),/VS (km/h)';
const ROMRAIDER_ROW = '0,34.9,34.2,15.9,3.054,0,136.56,19,773,14.5,-1.27,24.75,0,0,19.8,0';

test('every RomRaider column is recognised', () => {
    let seen = 0;
    const stats = readCsv(ROMRAIDER_HEADER + '\n' + ROMRAIDER_ROW + '\n', () => seen++);

    assert.strictEqual(seen, 1);
    assert.deepStrictEqual(stats.header.unmapped, [],
        'unrecognised columns: ' + stats.header.unmapped.join(', '));
    for (const expected of [
        CH.COOLANT_TEMP, CH.INTAKE_AIR_TEMP, CH.IGNITION_ADVANCE, CH.INJECTOR_PULSE,
        CH.KNOCK_CORRECTION, CH.ENGINE_LOAD, CH.MAF, CH.RPM, CH.TPS, CH.IACV,
        CH.LAMBDA_INT_1, CH.LAMBDA_INT_2, CH.CAM_ADVANCE, CH.VEHICLE_SPEED,
    ]) {
        assert.ok(stats.header.channels.has(expected), `${expected.name} was not resolved`);
    }
});

test('the absolute idle valve position wins over a correction channel of the same name', () => {
    // The log carries both `.IACV` (a correction, swinging negative) and
    // `.IACV_AlphaN` (the actual 0-100% position). Only the latter can answer
    // "is the valve saturated", and it appears *after* the other in the file,
    // so column order must not decide this.
    let sample = null;
    readCsv(ROMRAIDER_HEADER + '\n' + ROMRAIDER_ROW + '\n', s => { sample = s; });

    assert.ok(Math.abs(sample.get(CH.IACV) - 24.75) < 1e-9,
        'expected the AlphaN position (24.75), not the correction (-1.27)');
});

// ── Closed-throttle calibration ──────────────────────────────────────────

test('idle is found on a vehicle whose throttle rests well above zero', () => {
    // Regression test for a defect found against a RomRaider log: that car's
    // throttle sensor rests at 14.1%, not 0. A hardcoded "closed means under
    // 1%" never matched, so the pipeline found no idle anywhere in a 44-minute
    // drive. The opposite log rests at 0.0, so neither constant works.
    const drive = offset => new SyntheticLog()
        .phase({ seconds: 300, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, tpsOffset: offset })
        .phase({ seconds: 300, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, tpsOffset: offset });

    const secondsIdle = log => {
        const entry = run(log).overview.stateBreakdown.find(e => e.state === ST.IDLE_WARM);
        return entry ? entry.seconds : 0;
    };

    const restingAtZero = secondsIdle(drive(0));
    const restingHigh = secondsIdle(drive(14.5));

    assert.ok(restingAtZero > 200, `baseline idle detection broke: ${restingAtZero}s`);
    assert.ok(restingHigh > 200,
        `idle must still be found when the throttle rests at 14.5%, got ${restingHigh}s`);
});

// ── Knock ────────────────────────────────────────────────────────────────

test('knock reported by the ECU is detected and rated on measured evidence', () => {
    const report = run(new SyntheticLog()
        .phase({ seconds: 200, rpm: 2000, load: 150, tps: 20, speed: 60, coolant: 92 })
        .phase({ seconds: 60, rpm: 3200, load: 450, tps: 70, speed: 100, coolant: 95, knockCorrection: -4.5 })
        .phase({ seconds: 200, rpm: 2000, load: 150, tps: 20, speed: 60, coolant: 92 })
        .phase({ seconds: 60, rpm: 3400, load: 470, tps: 72, speed: 105, coolant: 95, knockCorrection: -5.0 })
        .phase({ seconds: 200, rpm: 2000, load: 150, tps: 20, speed: 60, coolant: 92 })
        .phase({ seconds: 60, rpm: 3300, load: 460, tps: 71, speed: 102, coolant: 95, knockCorrection: -4.8 })
        .phase({ seconds: 200, rpm: 2000, load: 150, tps: 20, speed: 60, coolant: 92 }));

    const f = finding(report, 'ignition.knock_confirmed');
    assert.ok(f, 'expected a confirmed-knock finding');
    // A direct measurement, so the rule is entitled to full confidence.
    assert.strictEqual(f.confidence, CONFIDENCE.HIGH);
});

test('the inferred knock rule stands down when a real knock channel is present', () => {
    const report = run(new SyntheticLog()
        .phase({ seconds: 300, rpm: 2000, load: 150, tps: 20, speed: 60, coolant: 92 })
        .phase({ seconds: 120, rpm: 3200, load: 450, tps: 70, speed: 100, coolant: 95, knockCorrection: -4.5 }));

    assert.ok(report.skipped.some(s => s.detectorId === 'ignition.knock_retard'),
        'the inferred rule should be reported as superseded, not silently absent');
    assert.ok(!has(report, 'ignition.knock_retard'));
});

test('a quiet knock channel produces no finding', () => {
    const report = run(new SyntheticLog().healthyDrive());
    assert.ok(!has(report, 'ignition.knock_confirmed'));
});

// ── Cam timing ───────────────────────────────────────────────────────────

test('a cam that never moves across a varied drive is reported', () => {
    const report = run(new SyntheticLog()
        .phase({ seconds: 200, rpm: 850, load: 95, tps: 0, speed: 0, coolant: 92, camAdvance: 20 })
        .phase({ seconds: 200, rpm: 2400, load: 200, tps: 25, speed: 80, coolant: 92, camAdvance: 20 })
        .phase({ seconds: 200, rpm: 3800, load: 460, tps: 70, speed: 120, coolant: 95, camAdvance: 20 }));
    assert.ok(has(report, 'ignition.cam_stuck'));
});

test('a cam that sweeps with engine speed is not reported', () => {
    const report = run(new SyntheticLog()
        .phase({ seconds: 200, rpm: 850, load: 95, tps: 0, speed: 0, coolant: 92, camAdvance: 20 })
        .phase({ seconds: 200, rpm: 2400, load: 200, tps: 25, speed: 80, coolant: 92, camAdvance: 38 })
        .phase({ seconds: 200, rpm: 3800, load: 460, tps: 70, speed: 120, coolant: 95, camAdvance: 45 }));
    assert.ok(!has(report, 'ignition.cam_stuck'));
});

test('a drive with no engine speed variety produces no cam verdict either way', () => {
    // Idling for ten minutes proves nothing about a cam that only advances off idle.
    const report = run(new SyntheticLog()
        .phase({ seconds: 600, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, camAdvance: 20 }));
    assert.ok(!has(report, 'ignition.cam_stuck'));
});

// ── Frozen feeds ─────────────────────────────────────────────────────────

test('a frozen feed is excluded rather than read as steady driving', () => {
    // Regression test for a real false positive. On the reference log the engine
    // is switched off 35 s before the end; the ECU stops answering and the logger
    // repeats its last values, while the analog input correctly records the
    // battery falling to 12.4 V with the alternator stopped. Those frozen samples
    // were classified as steady cruise, and the voltage reading below them was
    // reported as a 35-second charging fault on a car that was simply parked.
    const drive = () => new SyntheticLog()
        .phase({ seconds: 700, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 13.8 });

    const clean = analyze(drive().build());
    assert.strictEqual(clean.overview.staleSeconds, 0, 'normal driving must never look frozen');

    // Same drive, then the feed freezes with the voltage channel reading low.
    const withTail = drive();
    withTail.phase({ seconds: 1, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 12.3 });
    withTail.frozen(40);
    const report = analyze(withTail.build());

    assert.ok(report.overview.staleSeconds > 35,
        `expected the frozen stretch to be excluded, got ${report.overview.staleSeconds}s`);
    assert.strictEqual(report.overview.staleSpanCount, 1);
    assert.ok(!has(report, 'electrical.charging'),
        'a parked car with a frozen feed is not a charging fault');
});

test('a short repeat is not mistaken for a frozen feed', () => {
    // Loggers legitimately repeat a value when a channel updates more slowly
    // than the log rate, so only a sustained freeze counts.
    const log = new SyntheticLog()
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92 });
    log.frozen(1);
    log.phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92 });

    assert.strictEqual(analyze(log.build()).overview.staleSeconds, 0);
});

// ── Evidence formatting ──────────────────────────────────────────────────

test('evidence never prints its own timestamp twice', () => {
    // The value carries the measurement and timeMs carries the when; the
    // renderer places the time. A value that also spells out a clock time gets
    // rendered twice, and by two functions that rounded differently.
    const log = new SyntheticLog()
        .phase({ seconds: 600, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 13.8 })
        .phase({ seconds: 40, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 12.3 })
        .phase({ seconds: 300, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 13.8 });

    const report = analyze(log.build());
    for (const f of report.groups.flatMap(g => g.all)) {
        for (const e of f.evidence) {
            if (e.timeMs === null || e.timeMs === undefined) continue;
            assert.ok(!/\d+:\d\d/.test(e.value),
                `${f.detectorId} / ${e.label}: value "${e.value}" repeats the timestamp it already carries`);
        }
    }
});

test('freezes in the middle of a log are caught, not just at the end', () => {
    // The merged-file case: a day's logs are stitched into one file with a
    // continuous clock, so a stop-and-restart between parts lands mid-file
    // rather than at the tail, with no time gap to give it away.
    const log = new SyntheticLog()
        .phase({ seconds: 300, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 13.8 });
    log.frozen(25);
    log.phase({ seconds: 300, rpm: 2100, load: 175, tps: 17, speed: 68, coolant: 92, volts: 13.8 });
    log.frozen(12);
    log.phase({ seconds: 300, rpm: 2300, load: 185, tps: 19, speed: 72, coolant: 92, volts: 13.8 });

    const report = analyze(log.build());
    assert.strictEqual(report.overview.staleSpanCount, 2, 'both mid-file freezes must be found');
    assert.ok(Math.abs(report.overview.staleSeconds - 37) < 2,
        `expected ~37s excluded, got ${report.overview.staleSeconds}`);
});

test('a mid-file freeze is not bridged into invented driving', () => {
    // Engine stopped mid-file with the voltage channel reading a resting
    // battery, then restarted. The frozen stretch must be absent from the
    // state breakdown rather than attributed to some kind of driving, and it
    // must not raise a charging fault on a car that was parked.
    const log = new SyntheticLog()
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 13.8 })
        .phase({ seconds: 1, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 12.3 });
    log.frozen(45);
    log.phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, volts: 13.8 });

    const report = analyze(log.build());
    assert.ok(!has(report, 'electrical.charging'), 'a parked car is not a charging fault');

    const inStates = report.overview.stateBreakdown.reduce((sum, e) => sum + e.seconds, 0);
    const unaccounted = report.overview.durationSeconds - inStates;
    assert.ok(unaccounted > 40,
        `the frozen stretch must be left out of the state breakdown, only ${unaccounted.toFixed(1)}s was`);
});

// ── Ambient temperature ──────────────────────────────────────────────────

test('a single dropped reading cannot set the ambient estimate', () => {
    // The reference log's intake sensor dithers around 34 degC while the car
    // sits still with a hot engine, then reads 13.5 for exactly one sample. A
    // plain minimum took that reading as the outside air temperature.
    const tracker = new CarDoctor.SustainedMinTracker(10_000);
    for (let i = 0; i < 300; i++) {
        // 5 Hz, steady at 30 degC, with one dropout a third of the way in.
        tracker.observe(i * 200, i === 100 ? 5 : 30);
    }
    assert.strictEqual(tracker.value, 30, 'a one-sample dropout must not win');
});

test('the ambient estimate tracks a genuinely sustained low', () => {
    const tracker = new CarDoctor.SustainedMinTracker(10_000);
    for (let i = 0; i < 150; i++) tracker.observe(i * 200, 40);
    // 30 s held at 18 degC is a real reading, not a glitch.
    for (let i = 150; i < 300; i++) tracker.observe(i * 200, 18);
    assert.strictEqual(tracker.value, 18);
});

test('a window is never spanned across a gap', () => {
    const tracker = new CarDoctor.SustainedMinTracker(10_000);
    for (let i = 0; i < 100; i++) tracker.observe(i * 200, 40);
    tracker.reset();
    // Only 2 s on the far side of the gap: too short to conclude anything.
    for (let i = 0; i < 10; i++) tracker.observe(600_000 + i * 200, 5);
    assert.strictEqual(tracker.value, 40, 'the short stretch after a gap must not count');
});

test('heat soak prefers a supplied outside air temperature over its own guess', () => {
    // Intake sitting at 55 degC. Whether that is a fault depends entirely on
    // how hot it is outside, which the log cannot know and a weather lookup can.
    const log = () => new SyntheticLog()
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, iat: 55 })
        .build();

    const cold = analyze(log(), { profile: CarDoctor.makeProfile({ ambientC: 10 }) });
    const hot = analyze(log(), { profile: CarDoctor.makeProfile({ ambientC: 45 }) });

    assert.ok(has(cold, 'air.intake_heatsoak'), '55 degC intake on a 10 degC day is heat soak');
    assert.ok(!has(hot, 'air.intake_heatsoak'), '55 degC intake on a 45 degC day is just a hot day');

    const f = finding(cold, 'air.intake_heatsoak');
    assert.ok(f.evidence.some(e => e.label === 'Outside air'),
        'the report must say the figure was measured, not inferred');
});

test('a dropped intake reading does not invent a heat soak finding', () => {
    // End to end: the same defect the reference log carries.
    const rows = new SyntheticLog()
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, iat: 40 })
        .build()
        .split('\n');
    // Intake air temp is column 8. Drop exactly one sample to 5 degC.
    const cells = rows[600].split(',');
    cells[8] = '5.00';
    rows[600] = cells.join(',');

    const report = analyze(rows.join('\n'));
    assert.ok(!has(report, 'air.intake_heatsoak'),
        'one bad sample must not become the outside air temperature');
    assert.ok(report.summary.timeline.ambientEstimateC > 30,
        `ambient should track the real level, got ${report.summary.timeline.ambientEstimateC}`);
});

// ── Learned load scale ───────────────────────────────────────────────────

test('full load is learned from the drive rather than assumed', () => {
    // A big engine that pulls to 900 mg/str. The generic 400 would call
    // two-thirds of its range a full-load pull.
    const log = new SyntheticLog()
        .phase({ seconds: 300, rpm: 2000, load: 250, tps: 20, speed: 60, coolant: 92 })
        .phase({ seconds: 60, rpm: 4000, load: 900, tps: 75, speed: 120, coolant: 95 })
        .phase({ seconds: 300, rpm: 2000, load: 250, tps: 20, speed: 60, coolant: 92 })
        .build();

    const scale = CarDoctor.calibrateLoadScale(log, CarDoctor.DEFAULT_PROFILE);
    assert.ok(scale, 'a drive with real full-throttle running must calibrate');
    assert.ok(Math.abs(scale.highLoadThreshold - 900) < 100,
        `expected about 900 mg/str, got ${scale.highLoadThreshold}`);

    const report = analyze(log);
    assert.strictEqual(report.overview.loadScaleCalibrated, true);
    assert.ok(report.overview.highLoadThreshold > 700);
});

test('a drive with no full-throttle running keeps the generic scale', () => {
    // Gentle pottering proves nothing about what this engine can make, so the
    // default must stand rather than be set by whatever the drive happened to do.
    const log = new SyntheticLog()
        .phase({ seconds: 600, rpm: 1800, load: 150, tps: 15, speed: 50, coolant: 92 })
        .build();

    assert.strictEqual(CarDoctor.calibrateLoadScale(log, CarDoctor.DEFAULT_PROFILE), null);
    const report = analyze(log);
    assert.strictEqual(report.overview.loadScaleCalibrated, false);
    assert.strictEqual(report.overview.highLoadThreshold, CarDoctor.DEFAULT_PROFILE.highLoadThreshold);
});

test('a log without a throttle channel cannot calibrate, and says so', () => {
    const lines = ['Timestamp (ms),engine speed (RPM),engine load (mg/str),coolant temp (C)'];
    for (let i = 0; i < 4000; i++) {
        lines.push(`${i * 66},${2000 + i % 11},${300 + i % 23},${92 + (i % 5) * 0.25}`);
    }
    const log = lines.join('\n');
    assert.strictEqual(CarDoctor.calibrateLoadScale(log, CarDoctor.DEFAULT_PROFILE), null,
        'no throttle channel means no evidence of full throttle');
    assert.strictEqual(analyze(log).overview.loadScaleCalibrated, false);
});

test('one load spike cannot set the scale', () => {
    // The same failure the ambient estimate had: a quantile, not a maximum.
    const rows = new SyntheticLog()
        .phase({ seconds: 200, rpm: 2000, load: 250, tps: 20, speed: 60, coolant: 92 })
        .phase({ seconds: 60, rpm: 4000, load: 500, tps: 75, speed: 120, coolant: 95 })
        .build()
        .split('\n');
    // Engine load is column 2. One absurd reading while at full throttle.
    const spikeRow = rows.length - 10;
    const cells = rows[spikeRow].split(',');
    cells[2] = '2400.00';
    rows[spikeRow] = cells.join(',');

    const scale = CarDoctor.calibrateLoadScale(rows.join('\n'), CarDoctor.DEFAULT_PROFILE);
    assert.ok(scale.highLoadThreshold < 700,
        `one spike must not drag the scale up, got ${scale.highLoadThreshold}`);
});

// ── The shared vehicle record ────────────────────────────────────────────

test('the vehicle record carries outside air into the analysis', () => {
    // One record, two consumers: prose for the AI hand-off, numbers for here.
    const vehicle = { chassis: 'E36', engine: 'M52B28', ecu: 'MS41', location: 'Colombo', ambient: '31' };
    const profile = CarDoctor.profileFromVehicle(vehicle);
    assert.strictEqual(profile.ambientC, 31);
    assert.strictEqual(profile.name, 'E36 M52B28');

    // The figure has to survive the trip into the pipeline and be used as a
    // measurement, which the report states outright.
    const log = new SyntheticLog()
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, iat: 62 })
        .build();

    const stated = finding(analyze(log, { profile }), 'air.intake_heatsoak');
    assert.ok(stated, '62 degC intake on a stated 31 degC day is a 31 degC rise');
    assert.ok(stated.evidence.some(e => e.label === 'Outside air' && e.value.includes('31.0')),
        'the report must show it used the stated figure, not its own guess');

    // A hot enough day explains the same intake temperature away entirely.
    const hotDay = Object.assign({}, vehicle, { ambient: '45' });
    assert.ok(!has(analyze(log, { profile: CarDoctor.profileFromVehicle(hotDay) }), 'air.intake_heatsoak'),
        '62 degC intake on a 45 degC day is just a hot day');
});

test('junk in the ambient box is ignored rather than believed', () => {
    for (const ambient of ['', '  ', 'warm', '999', '-200']) {
        assert.strictEqual(CarDoctor.profileFromVehicle({ ambient }).ambientC, null,
            `"${ambient}" must not become a temperature`);
    }
});

// ── Bimmer Cockpit (MS43 over K-line) logs ───────────────────────────────

const COCKPIT_HEADER =
    'Time (ms),Engine speed (rpm),Vehicle speed (km/h),Throttle position (%),Accelerator pedal (%),' +
    'Engine load (mg/stroke),Mass airflow (kg/h),Ignition advance (deg),Injection time (ms),' +
    'Intake air temp (C),Coolant temp (C),Oil temp (C),Radiator temp (C),IACV (%),Idle actuator (%),' +
    'Intake cam (deg),Exhaust cam (deg),Lambda int 1 (%),Lambda int 2 (%),Knock sensor 1 (V),' +
    'Knock sensor 2 (V),Battery voltage (V),System voltage (V),Fuel rate (l/h),Torque (%),Torque loss (%),' +
    'ECU fan (%),O2 heater pre 1 (%),O2 heater pre 2 (%),O2 heater post 1 (%),O2 heater post 2 (%),' +
    'Evaporator temp (C),Cabin temp (C),AC pressure (bar),AC switch,Compressor,Blower,Check engine,EML';
const COCKPIT_ROW =
    '36,797,0,0,0,96,14.6,5.6,1.86,40,97,87,81,0.2,34,30,-45,-13,-10.8,0.38,0.25,14,14,0.44,11,7.4,' +
    '5,198,198,198,198,14.5,25.6,,1,0,2,0,0';

test('every engine column in a Bimmer Cockpit log is recognised', () => {
    let sample = null;
    const stats = readCsv(COCKPIT_HEADER + '\n' + COCKPIT_ROW + '\n', s => { sample = s; });
    for (const expected of [
        CH.PEDAL, CH.EXHAUST_CAM, CH.CAM_ADVANCE, CH.AC_COMPRESSOR, CH.CHECK_ENGINE, CH.EML, CH.ECU_FAN,
        CH.IACV, CH.INJECTOR_PULSE, CH.LAMBDA_INT_1, CH.LAMBDA_INT_2, CH.RADIATOR_TEMP,
    ]) {
        assert.ok(stats.header.channels.has(expected), `${expected.name} was not resolved`);
    }
    // Only the module's own climate columns and values no rule reads are left over.
    assert.deepStrictEqual(stats.header.unmapped.sort(), [
        'AC pressure (bar)', 'AC switch', 'Blower', 'Cabin temp (C)', 'Evaporator temp (C)',
        'Knock sensor 1 (V)', 'Knock sensor 2 (V)', 'O2 heater post 1 (%)', 'O2 heater post 2 (%)',
        'O2 heater pre 1 (%)', 'O2 heater pre 2 (%)', 'Torque (%)', 'Torque loss (%)',
    ]);
    // The MS43's "IACV" reads 0.2% at idle; the idle actuator is the valve.
    assert.strictEqual(sample.get(CH.IACV), 34);
});

test('a lamp that stayed off all drive is evidence, not a dead input', () => {
    const tracker = new ChannelHealthTracker();
    for (let i = 0; i < 100; i++) tracker.observe(CH.CHECK_ENGINE, 0);
    assert.strictEqual(tracker.finish().get(CH.CHECK_ENGINE).status, STATUS_OK);
});

// ── Accelerator pedal ────────────────────────────────────────────────────

function pedalSample(timeMs, rpm, load, tps, pedal, speed) {
    const sample = driveSample(timeMs, rpm, load, tps, speed, 92);
    sample.values[CH.PEDAL.ordinal] = pedal;
    return sample;
}

test('a pressed pedal is not overrun, even with the throttle plate shut', () => {
    // An MS43 feeds light-load air through the idle actuator with the plate
    // shut, so the throttle reads 0% and load is low while the car cruises.
    const segmenter = new StateSegmenter(DEFAULT_PROFILE);
    let overrun = 0;
    for (let i = 0; i < 200; i++) {
        if (segmenter.analyze(pedalSample(i * 200, 1600, 70, 0, 8, 50)).state === ST.DECEL_OVERRUN) overrun++;
    }
    assert.strictEqual(overrun, 0, 'the driver is asking for power - this is not overrun');

    const released = new StateSegmenter(DEFAULT_PROFILE);
    let real = 0;
    for (let i = 0; i < 200; i++) {
        if (released.analyze(pedalSample(i * 200, 1600, 60, 0, 0, 50)).state === ST.DECEL_OVERRUN) real++;
    }
    assert.ok(real > 150, `pedal released and load gone is overrun, got ${real} of 200`);
});

test('a floored pedal is a full-load pull even when the throttle reads part-open', () => {
    const segmenter = new StateSegmenter(DEFAULT_PROFILE);
    let pull = 0;
    for (let i = 0; i < 100; i++) {
        if (segmenter.analyze(pedalSample(i * 200, 3500, 300, 30, 95, 100)).state === ST.WOT_PULL) pull++;
    }
    assert.ok(pull > 80, `expected a full-load pull, got ${pull} of 100`);
});

// ── Exhaust cam ──────────────────────────────────────────────────────────

test('an exhaust cam that never moves is reported on its own', () => {
    const exhaust = i => (-45 + Math.sin(i / 7) * 0.3).toFixed(2);
    const report = run(new SyntheticLog(7, ['Exhaust cam (deg)'])
        .phase({ seconds: 200, rpm: 850, load: 95, tps: 0, speed: 0, coolant: 92, camAdvance: 20, extras: { 'Exhaust cam (deg)': exhaust } })
        .phase({ seconds: 200, rpm: 2400, load: 200, tps: 25, speed: 80, coolant: 92, camAdvance: 38, extras: { 'Exhaust cam (deg)': exhaust } })
        .phase({ seconds: 200, rpm: 3800, load: 460, tps: 70, speed: 120, coolant: 95, camAdvance: 45, extras: { 'Exhaust cam (deg)': exhaust } }));
    assert.ok(has(report, 'ignition.exhaust_cam_stuck'), 'got: ' + titles(report));
    assert.ok(!has(report, 'ignition.cam_stuck'), 'the intake cam swept normally');
});

test('cams in BMW\'s crankshaft angles are read, not rejected as implausible', () => {
    // How the MS43 reports them: intake about 90-127 deg, exhaust about -106 to -83.
    const exhaust = i => (-100 + Math.sin(i / 7) * 0.3).toFixed(2);
    const report = run(new SyntheticLog(7, ['Exhaust cam (deg)'])
        .phase({ seconds: 200, rpm: 850, load: 95, tps: 0, speed: 0, coolant: 92, camAdvance: 125, extras: { 'Exhaust cam (deg)': exhaust } })
        .phase({ seconds: 200, rpm: 2400, load: 200, tps: 25, speed: 80, coolant: 92, camAdvance: 125, extras: { 'Exhaust cam (deg)': exhaust } })
        .phase({ seconds: 200, rpm: 3800, load: 460, tps: 70, speed: 120, coolant: 95, camAdvance: 125, extras: { 'Exhaust cam (deg)': exhaust } }));
    assert.ok(has(report, 'ignition.cam_stuck'), 'got: ' + titles(report));
    assert.ok(has(report, 'ignition.exhaust_cam_stuck'), 'got: ' + titles(report));
});

// ── Warning lamps ────────────────────────────────────────────────────────

test('a check engine lamp lit while driving is reported', () => {
    const report = run(new SyntheticLog(7, ['Check engine', 'EML'])
        .phase({ seconds: 200, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, extras: { 'Check engine': 0, EML: 0 } })
        .phase({ seconds: 60, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, extras: { 'Check engine': 1, EML: 0 } }));
    const f = finding(report, 'ecu.warning_lamp');
    assert.ok(f, 'expected a warning lamp finding, got: ' + titles(report));
    assert.strictEqual(f.severity, SEVERITY.MODERATE);
    assert.strictEqual(f.confidence, CONFIDENCE.HIGH);
});

test('the EML lamp outranks the check engine lamp', () => {
    const report = run(new SyntheticLog(7, ['Check engine', 'EML'])
        .phase({ seconds: 200, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, extras: { 'Check engine': 1, EML: 1 } }));
    assert.strictEqual(finding(report, 'ecu.warning_lamp').severity, SEVERITY.HIGH);
});

test('the key-on bulb check is not a warning', () => {
    // Both lamps light with the key on and the engine stopped.
    const report = run(new SyntheticLog(7, ['Check engine', 'EML'])
        .phase({ seconds: 20, rpm: 0, rpmJitter: 0, load: 0, tps: 0, speed: 0, coolant: 92, extras: { 'Check engine': 1, EML: 1 } })
        .phase({ seconds: 300, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, extras: { 'Check engine': 0, EML: 0 } }));
    assert.ok(!has(report, 'ecu.warning_lamp'));
});

// ── AC compressor ────────────────────────────────────────────────────────

test('an idle that only wobbles with the AC compressor running is not a fault', () => {
    const drive = headers => new SyntheticLog(7, headers)
        .phase({ seconds: 300, rpm: 800, rpmJitter: 300, load: 115, tps: 0, speed: 0, coolant: 92, extras: { Compressor: 1 } })
        .phase({ seconds: 150, rpm: 780, rpmJitter: 5, load: 95, tps: 0, speed: 0, coolant: 92, extras: { Compressor: 0 } });
    // Without the AC state the same idle is rough enough to report...
    assert.ok(has(run(drive([])), 'idle.unstable'));
    // ...but it is steady whenever the compressor is off, so the load explains it.
    assert.ok(!has(run(drive(['Compressor'])), 'idle.unstable'));
});

test('an idle rough with the AC off as well is reported, with the AC stated', () => {
    const report = run(new SyntheticLog(7, ['Compressor'])
        .phase({ seconds: 200, rpm: 800, rpmJitter: 300, load: 115, tps: 0, speed: 0, coolant: 92, extras: { Compressor: 1 } })
        .phase({ seconds: 200, rpm: 780, rpmJitter: 300, load: 95, tps: 0, speed: 0, coolant: 92, extras: { Compressor: 0 } }));
    const f = finding(report, 'idle.unstable');
    assert.ok(f, 'expected an unstable idle finding');
    assert.ok(f.evidence.some(e => e.label === 'Idle roughness, AC off'));
    assert.strictEqual(f.confidence, CONFIDENCE.MEDIUM);
});

// ── Rich at low load ─────────────────────────────────────────────────────

test('fuel removed at low load only reads as an unmetered fuel source', () => {
    // The mirror of a vacuum leak: a fixed amount of stray fuel.
    const stray = load => Math.max(-16, -14 * (100 / load));
    const report = run(new SyntheticLog()
        .phase({ seconds: 200, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, trimAtLoad: stray })
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, trimAtLoad: stray })
        .phase({ seconds: 200, rpm: 3600, load: 480, tps: 75, speed: 120, coolant: 95, trimAtLoad: stray }));
    const f = finding(report, 'fuel.rich_low_load');
    assert.ok(f, 'expected a low-load rich finding, got: ' + titles(report));
    assert.strictEqual(f.confidence, CONFIDENCE.MEDIUM, 'the converging shape was seen');
    assert.ok(!has(report, 'fuel.unmetered_air'));
});

// ── Engine profile ───────────────────────────────────────────────────────

test('an M54 on an MS43 gets its own limits, other engines stay generic', () => {
    const m54 = CarDoctor.profileFromVehicle({ chassis: 'E36', engine: 'M54B30', ecu: 'MS43' });
    assert.strictEqual(m54.overheatCoolantC, 115);
    assert.strictEqual(m54.highLoadThreshold, 550);
    assert.strictEqual(m54.name, 'E36 M54B30');
    assert.strictEqual(CarDoctor.profileFromVehicle({ engine: 'M54B30 (MS43)' }).overheatCoolantC, 115);

    const m52 = CarDoctor.profileFromVehicle({ engine: 'M52B28', ecu: 'MS41' });
    assert.strictEqual(m52.overheatCoolantC, DEFAULT_PROFILE.overheatCoolantC);
    assert.strictEqual(m52.highLoadThreshold, DEFAULT_PROFILE.highLoadThreshold);
});

test('an M54 running its map thermostat hot at cruise is not overheating', () => {
    const log = new SyntheticLog()
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 112 });
    const m54 = CarDoctor.profileFromVehicle({ engine: 'M54B30', ecu: 'MS43' });
    assert.ok(!has(run(log, m54), 'cooling.overheat'));
    assert.ok(has(run(log), 'cooling.overheat'), 'the generic limit still applies to an unknown engine');
});

// ── ECU snapshot ─────────────────────────────────────────────────────────

const DRIVE_START = '2026-10-27T14:15:00Z';
const snapshot = extra => Object.assign({
    takenAt: '2026-10-27T14:50:00Z', dme: '7551615', faults: [],
    adaptations: { additiveMs: [0.01, -0.01], multiplicativePct: [1.2, 0.8] }, ronAdaptationPct: 0,
}, extra);
const withSnapshot = (log, ecu, profile) =>
    analyze(log.build(), { profile, ecu, logStartedAt: DRIVE_START });

test('without a snapshot the ECU rules stay silent rather than listed as unchecked', () => {
    const report = run(new SyntheticLog().healthyDrive());
    const ecuRules = ['ecu.misfire', 'fuel.adaptation', 'ignition.octane_adaptation'];
    assert.ok(!report.skipped.some(s => ecuRules.includes(s.detectorId)));
    assert.ok(!report.groups.some(g => g.all.some(f => ecuRules.includes(f.detectorId))));
    assert.strictEqual(report.overview.ecu, null);
});

test('a healthy snapshot adds nothing to a healthy drive', () => {
    const report = withSnapshot(new SyntheticLog().healthyDrive(), snapshot());
    const significant = report.groups.filter(g => g.severity.rank >= SEVERITY.MODERATE.rank);
    assert.strictEqual(significant.length, 0, 'got: ' + significant.map(g => g.primary.title).join(', '));
    assert.ok(report.overview.ecu.hoursFromDrive < 1);
});

test('stored misfires name their cylinders', () => {
    const report = withSnapshot(new SyntheticLog().healthyDrive(), snapshot({
        faults: [{ code: 241, text: 'Misfire Cyl 4' }, { code: 238, text: 'Misfire Cyl 1' }],
    }));
    const f = finding(report, 'ecu.misfire');
    assert.ok(f);
    assert.strictEqual(f.title, 'Misfire stored: cylinder 1, 4');
    assert.strictEqual(f.severity, SEVERITY.HIGH);
    // Handled by the misfire rule, not repeated as an unexplained code.
    assert.ok(!has(report, 'ecu.stored_faults'));
});

test('misfire counters name their cylinders before a fault is stored', () => {
    const report = withSnapshot(new SyntheticLog().healthyDrive(), snapshot({
        misfire: { counts: [0, 0, 0, 0, 14, 0], roughness: [0.01, 0, 0, 0, 0.9, 0] },
    }));
    const f = finding(report, 'ecu.misfire');
    assert.ok(f, 'got: ' + titles(report));
    assert.strictEqual(f.title, 'Misfires counted: cylinder 5');
    assert.strictEqual(f.severity, SEVERITY.MODERATE);
    assert.ok(f.evidence.some(e => e.label === 'Misfire counter, cylinder 5' && e.value.startsWith('14')));
});

test('a stored misfire and the counters are one finding', () => {
    const report = withSnapshot(new SyntheticLog().healthyDrive(), snapshot({
        faults: [{ code: 238, text: 'Misfire Cyl 1', frequency: 4, presentNow: true }],
        misfire: { counts: [9, 0, 0, 0, 0, 0], roughness: [0.5, 0, 0, 0, 0, 0] },
    }));
    const all = report.groups.flatMap(g => g.all).filter(x => x.detectorId === 'ecu.misfire');
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].title, 'Misfire stored: cylinder 1');
    assert.strictEqual(all[0].severity, SEVERITY.HIGH);
    assert.ok(all[0].evidence.some(e => e.value === '238: Misfire Cyl 1 (present now; occurred 4x)'));
});

test('zero misfire counters add nothing', () => {
    const report = withSnapshot(new SyntheticLog().healthyDrive(), snapshot({
        misfire: { counts: [0, 0, 0, 0, 0, 0], roughness: [0, 0, 0, 0, 0, 0] },
    }));
    assert.ok(!has(report, 'ecu.misfire'));
    assert.ok(report.overview.ecu.misfire);
});

test('what the ECU stored with a fault joins its evidence', () => {
    const report = withSnapshot(new SyntheticLog().healthyDrive(), snapshot({
        faults: [{ code: 125, text: 'Activation Electric Fan', frequency: 2, presentNow: false,
            types: ['Short circuit to ground or open circuit'], conditions: ['Engine speed 800.0 rpm'] }],
    }));
    const f = finding(report, 'ecu.stored_faults');
    assert.strictEqual(f.evidence[0].value, '125: Activation Electric Fan (not present now; occurred 2x; ' +
        'Short circuit to ground or open circuit; stored at Engine speed 800.0 rpm)');
});

test('the learned idle air backs up a rough idle', () => {
    const log = new SyntheticLog(7, ['Compressor'])
        .phase({ seconds: 200, rpm: 800, rpmJitter: 300, load: 115, tps: 0, speed: 0, coolant: 92, extras: { Compressor: 1 } })
        .phase({ seconds: 200, rpm: 780, rpmJitter: 300, load: 95, tps: 0, speed: 0, coolant: 92, extras: { Compressor: 0 } });
    const report = withSnapshot(log, snapshot({ idleAdaptationPct: { neutral: -4.2, inGear: -3, ac: 1.5 } }));
    const f = finding(report, 'idle.unstable');
    assert.ok(f.evidence.some(e => e.label === 'Learned idle air (ECU)' &&
        e.value === 'neutral -4.2%, in gear -3.0%, AC on +1.5%'));
});

test('a stored code backs up the finding it explains, and an unrelated one is listed', () => {
    const leak = load => Math.min(16, 14 * (100 / load));
    const log = new SyntheticLog()
        .phase({ seconds: 200, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, trimAtLoad: leak })
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, trimAtLoad: leak })
        .phase({ seconds: 200, rpm: 3600, load: 480, tps: 75, speed: 120, coolant: 95, trimAtLoad: leak });
    const before = finding(run(log), 'fuel.unmetered_air');

    const report = withSnapshot(log, snapshot({
        faults: [{ code: 227, text: 'Mixture Deviation Bank 1' }, { code: 36, text: 'DME Main Relay' }],
    }));
    const leakFinding = finding(report, 'fuel.unmetered_air');
    assert.ok(leakFinding.evidence.some(e => e.value.startsWith('227')));
    assert.ok(leakFinding.confidence.rank > before.confidence.rank ||
        leakFinding.confidence === CONFIDENCE.HIGH, 'two sources agreeing must raise confidence');
    const listed = finding(report, 'ecu.stored_faults');
    assert.ok(listed && listed.evidence.length === 1 && listed.evidence[0].value.startsWith('36'));
});

function idleInjectionLog() {
    const injection = i => (2.0 + (i % 3) * 0.01).toFixed(3);
    return new SyntheticLog(7, ['Injection time (ms)'])
        .phase({ seconds: 200, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, extras: { 'Injection time (ms)': injection } })
        .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, extras: { 'Injection time (ms)': 4 } });
}

test('a learned idle correction shows a leak the short-term trims no longer do', () => {
    // Trims in the log are clean: the ECU has already adapted to the leak.
    const report = withSnapshot(idleInjectionLog(), snapshot({
        adaptations: { additiveMs: [0.3, 0.28], multiplicativePct: [1, 1] },
    }));
    const f = report.groups.flatMap(g => g.all).find(x => x.detectorId === 'fuel.adaptation');
    assert.ok(f, 'expected an adaptation finding, got: ' + titles(report));
    assert.strictEqual(f.causeKey, 'lean-low-load');
    assert.strictEqual(f.confidence, CONFIDENCE.MEDIUM);
    assert.ok(f.evidence.some(e => e.label.startsWith('Warm idle injection')));
});

test('a learned correction from weeks away is reported with low confidence', () => {
    const report = withSnapshot(idleInjectionLog(), snapshot({
        takenAt: '2026-08-01T10:00:00Z',
        adaptations: { additiveMs: [0.3, 0.28], multiplicativePct: [1, 1] },
    }));
    const f = report.groups.flatMap(g => g.all).find(x => x.detectorId === 'fuel.adaptation');
    assert.strictEqual(f.confidence, CONFIDENCE.LOW);
    assert.ok(f.summary.includes('days from this drive'));
});

test('a learned correction on one bank only points at that bank', () => {
    const report = withSnapshot(idleInjectionLog(), snapshot({
        adaptations: { additiveMs: [0, 0], multiplicativePct: [9, 1] },
    }));
    const causes = report.groups.flatMap(g => g.all)
        .filter(x => x.detectorId === 'fuel.adaptation').map(x => x.causeKey);
    assert.ok(causes.includes('bank-1'), 'got: ' + causes.join(', '));
});

test('junk in a snapshot is dropped rather than believed', () => {
    const ecu = CarDoctor.normalizeEcuSnapshot({
        takenAt: 'yesterday', faults: [{ code: 'x' }, null, { code: 238 }],
        adaptations: { additiveMs: ['a', 0.1], multiplicativePct: null }, ronAdaptationPct: 'lots',
    }, DRIVE_START);
    assert.strictEqual(ecu.takenAt, null);
    assert.strictEqual(ecu.hoursFromDrive, null);
    assert.deepStrictEqual(ecu.faults.map(f => f.code), [238]);
    assert.deepStrictEqual(ecu.adaptations.additiveMs, [null, 0.1]);
    assert.deepStrictEqual(ecu.adaptations.multiplicativePct, [null, null]);
    assert.strictEqual(ecu.ronAdaptationPct, null);
    assert.strictEqual(ecu.misfire, null);
    assert.strictEqual(ecu.idleAdaptationPct, null);
    assert.strictEqual(CarDoctor.normalizeEcuSnapshot(null), null);
    const odd = CarDoctor.normalizeEcuSnapshot({
        misfire: { counts: [1, 2, 3], roughness: [] }, idleAdaptationPct: { neutral: 'x' },
        digital: { acRequest: true, compressorRelay: 'yes' }, faults: [{ code: 1, types: [3, 'Open'], frequency: 'x' }],
    }, DRIVE_START);
    assert.strictEqual(odd.misfire, null, 'counters must cover all six cylinders');
    assert.strictEqual(odd.idleAdaptationPct, null);
    assert.deepStrictEqual(odd.digital, { acRequest: true });
    assert.deepStrictEqual(odd.faults[0].types, ['Open']);
    assert.strictEqual(odd.faults[0].frequency, null);
});

// ── Change over time ─────────────────────────────────────────────────────

const earlier = (day, idleTrim, name = 'drive-' + day) => ({
    version: 1, logName: name, logStartedAt: `2026-10-${String(day).padStart(2, '0')}T08:00:00Z`,
    runningSeconds: 900, metrics: { idleTrim: { value: idleTrim, n: 1000 } },
});
const creepingIdle = () => new SyntheticLog()
    .phase({ seconds: 200, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, trimAtLoad: () => 6.5 })
    .phase({ seconds: 300, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92 });
const withHistory = (log, history) =>
    analyze(log.build(), { history, logName: 'today', logStartedAt: DRIVE_START });

test('every drive leaves a record to compare the next one with', () => {
    const report = withHistory(new SyntheticLog().healthyDrive(), []);
    const metrics = report.record.metrics;
    for (const key of ['idleTrim', 'idleRpm', 'idleRoughness', 'lowLoadTrim', 'cruiseCoolant', 'runningVoltage']) {
        assert.ok(metrics[key] && Number.isFinite(metrics[key].value), `${key} missing from the record`);
    }
    assert.strictEqual(report.record.logName, 'today');
    // It must survive the trip through JSON, which is how the app stores it.
    assert.deepStrictEqual(JSON.parse(JSON.stringify(CarDoctor.toPlainReport(report).record)), report.record);
});

test('an idle trim creeping away from this car\'s own normal is reported', () => {
    const history = [earlier(1, 0.5), earlier(5, 1.2), earlier(9, 0.8), earlier(14, 1.0), earlier(20, 0.6)];
    const report = withHistory(creepingIdle(), history);
    const f = finding(report, 'trend.idleTrim');
    assert.ok(f, 'expected a drift finding, got: ' + titles(report));
    assert.strictEqual(f.causeKey, 'lean-low-load');
    assert.strictEqual(f.confidence, CONFIDENCE.MEDIUM);
    assert.strictEqual(report.overview.historyDrives, 5);
});

test('two earlier drives are not yet a normal', () => {
    const report = withHistory(creepingIdle(), [earlier(1, 0.5), earlier(5, 1.2)]);
    assert.ok(!has(report, 'trend.idleTrim'));
});

test('a metric that always varies this much is not a drift', () => {
    const history = [earlier(1, -6), earlier(5, 7), earlier(9, -4), earlier(14, 5), earlier(20, 0)];
    assert.ok(!has(withHistory(creepingIdle(), history), 'trend.idleTrim'));
});

test('the drive itself and later drives never set its baseline', () => {
    const history = [
        earlier(1, 0.5), earlier(5, 1.2),
        earlier(26, 6.5, 'today'),     // this very drive, analysed before
        earlier(28, 6.4), earlier(29, 6.6), // after it
    ];
    const report = withHistory(creepingIdle(), history);
    assert.strictEqual(report.overview.historyDrives, 2);
    assert.ok(!has(report, 'trend.idleTrim'));
});
