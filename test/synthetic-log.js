// Builds logs with known content.
//
// Real logs are the wrong tool for testing detectors: a log from a healthy car
// leaves every detector correctly silent, so none of them is actually
// exercised. Synthesising a drive lets a fault be injected deliberately and the
// detector asserted on.

'use strict';

/**
 * mulberry32 — a small deterministic PRNG.
 *
 * The tests need reproducible noise, not cryptographic quality. Seeding it
 * explicitly keeps a failing test failing the same way on the next run.
 */
function seededRandom(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const HEADER =
    'Timestamp (ms),engine speed (RPM),engine load (mg/str),tps (%),ignition angle (deg),' +
    'coolant temp (C),radiator temp (C),oil temp (C),intake air temp (C),speed (km/h),' +
    'lambda int 1 (%),lambda int 2 (%),input v (V),mass airflow (kg/h),iacv (%),' +
    'knock correction (deg),cam advance (deg)';

class SyntheticLog {
    constructor(seed = 7) {
        this.random = seededRandom(seed);
        this.rows = [HEADER];
        this.timeMs = 0;
        this.intervalMs = 66;
    }

    /**
     * @param opts.trimAtLoad returns the fuel trim the ECU would apply at a
     *   given load — the hook every mixture-fault test uses to inject its fault.
     */
    phase(opts) {
        const {
            seconds, rpm, load, tps, speed, coolant,
            trimAtLoad = () => 0,
            advance = 20,
            volts = 13.8,
            iat = 20,
            rpmJitter = 5,
            iacv = 30,
            radiatorOffset = 12,
            // Resting throttle reading. Real sensors do not all rest at zero.
            tpsOffset = 0,
            knockCorrection = 0,
            camAdvance = 20,
        } = opts;

        const samples = Math.trunc(seconds * 1000 / this.intervalMs);
        for (let i = 0; i < samples; i++) {
            const jitter = (this.random() - 0.5) * 2 * rpmJitter;
            // Every channel needs realistic noise. A perfectly constant channel
            // is indistinguishable from an unwired input, and the health gate
            // will correctly refuse to reason about it.
            const iatNoise = (this.random() - 0.5) * 1.2;
            const voltNoise = (this.random() - 0.5) * 0.25;
            const coolantNoise = (this.random() - 0.5) * 0.8;
            const trim = trimAtLoad(load) + (this.random() - 0.5) * 1.5;
            // Ignition follows load the way a real spark map does, so tests
            // exercise the learned baseline rather than a flat line.
            const mappedAdvance = advance - (load / 40) + Math.sin(i / 9) * 0.4;

            this.rows.push([
                this.timeMs,
                (rpm + jitter).toFixed(0),
                load.toFixed(2),
                (tps + tpsOffset).toFixed(2),
                mappedAdvance.toFixed(2),
                (coolant + coolantNoise).toFixed(2),
                (coolant - radiatorOffset + coolantNoise).toFixed(2),
                (coolant + 4).toFixed(2),
                (iat + iatNoise).toFixed(2),
                speed.toFixed(1),
                trim.toFixed(2),
                trim.toFixed(2),
                (volts + voltNoise).toFixed(2),
                (load * rpm / 6000).toFixed(2),
                iacv.toFixed(1),
                knockCorrection.toFixed(2),
                (camAdvance + (this.random() - 0.5) * 0.6).toFixed(2),
            ].join(','));
            this.timeMs += this.intervalMs;
        }
        return this;
    }

    /**
     * Repeats the last row verbatim, only the clock advancing.
     *
     * What a logger writes when the ECU stops answering: the connection drops or
     * the engine is switched off, and it keeps emitting the values it last
     * received rather than emitting nothing.
     */
    frozen(seconds) {
        const last = this.rows[this.rows.length - 1].split(',');
        const samples = Math.trunc(seconds * 1000 / this.intervalMs);
        for (let i = 0; i < samples; i++) {
            this.timeMs += this.intervalMs;
            this.rows.push([this.timeMs, ...last.slice(1)].join(','));
        }
        return this;
    }

    /** A complete, healthy drive: cold start, warm-up, idle, cruise and a pull. */
    healthyDrive() {
        return this
            .phase({ seconds: 60, rpm: 1100, load: 90, tps: 0, speed: 0, coolant: 30, iacv: 60, camAdvance: 20 })
            .phase({ seconds: 120, rpm: 900, load: 95, tps: 0, speed: 0, coolant: 70, iacv: 45, camAdvance: 20 })
            .phase({ seconds: 200, rpm: 820, load: 95, tps: 0, speed: 0, coolant: 92, iacv: 30, camAdvance: 20 })
            .phase({ seconds: 400, rpm: 2200, load: 180, tps: 18, speed: 70, coolant: 92, camAdvance: 36 })
            .phase({ seconds: 120, rpm: 3600, load: 480, tps: 75, speed: 120, coolant: 95, camAdvance: 44 });
    }

    build() { return this.rows.join('\n') + '\n'; }
}

module.exports = { SyntheticLog, HEADER, seededRandom };
