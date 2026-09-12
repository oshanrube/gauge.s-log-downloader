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
