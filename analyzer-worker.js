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
    const text = event.data && event.data.text;
    if (typeof text !== 'string') {
        self.postMessage({ type: 'error', message: 'no log text supplied' });
        return;
    }
    try {
        // Progress is throttled to whole percent: the pipeline reports every
        // 2000 rows, which on a large log is far more messages than the bar
        // can usefully show.
        let lastPercent = -1;
        const report = self.CarDoctor.analyze(text, {
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
