// analyzer-worker.js — runs the diagnosis off the UI thread.
//
// A long merged log takes a couple of seconds to analyse, which is long enough
// to freeze the interface and stall the progress bar if it runs inline. The
// worker is created best-effort: where it cannot be constructed (a webview that
// blocks workers, an unusual origin) the app falls back to running the same
// code synchronously, so analysis always works and only smoothness is lost.

'use strict';

importScripts('analyzer.js');

self.onmessage = event => {
    const data = event.data || {};
    const text = data.text;
    // Thresholds from the shared vehicle record, when the app had any.
    const profile = data.profile || undefined;
    if (typeof text !== 'string') {
        self.postMessage({ type: 'error', message: 'no log text supplied' });
        return;
    }
    try {
        // Progress is throttled to whole percent: the pipeline reports every
        // 2000 rows, which on a large log is far more messages than the bar
        // can usefully show.
        let lastPercent = -1;
        // The ECU snapshot near this drive and the records of earlier drives,
        // for an app that keeps them (see analyze() in analyzer.js).
        const report = self.CarDoctor.analyze(text, {
            profile,
            logName: data.logName,
            logStartedAt: data.logStartedAt,
            ecu: data.ecu,
            history: data.history,
            onProgress: fraction => {
                const percent = Math.round(fraction * 100);
                if (percent === lastPercent) return;
                lastPercent = percent;
                self.postMessage({ type: 'progress', value: fraction });
            },
        });
        self.postMessage({ type: 'done', report: self.CarDoctor.toPlainReport(report) });
    } catch (err) {
        self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
    }
};
