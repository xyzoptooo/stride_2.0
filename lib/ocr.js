import { createWorker } from 'tesseract.js';

let worker = null;
let initPromise = null;
let workerBroken = false; // If true, avoid retrying initialization repeatedly

async function initWorker() {
  if (workerBroken) {
    // If worker previously failed in a way that could crash the process, avoid re-initializing
    throw new Error('OCR worker marked as broken');
  }

  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Create the worker and attach defensive error handlers to the underlying thread if available
    worker = createWorker({});

    try {
      // Try to attach low-level error handlers to prevent worker thread errors from bubbling
      try {
        // tesseract.js internals may expose the underlying worker under different keys
        const underlying = worker?.worker || worker?._worker || worker?._workerThread || null;
        if (underlying && typeof underlying.on === 'function') {
          underlying.on('error', (err) => {
            console.warn('Underlying OCR worker thread emitted error:', err?.message || err);
            workerBroken = true;
            // Attempt to terminate the high-level worker to clean up resources
            try { if (worker && typeof worker.terminate === 'function') worker.terminate(); } catch (e) { /* noop */ }
          });
          // also listen for messageerror if present
          if (typeof underlying.on === 'function' && typeof underlying.addEventListener === 'function') {
            try { underlying.addEventListener('messageerror', (ev) => { console.warn('OCR worker messageerror', ev); workerBroken = true; }); } catch (e) { /* ignore */ }
          }
        }
      } catch (attachErr) {
        // Non-fatal: just log and continue
        console.warn('Could not attach underlying worker error handlers:', attachErr?.message || attachErr);
      }

      await worker.load();
      await worker.loadLanguage('eng');
      await worker.initialize('eng');
      return worker;
    } catch (err) {
      console.warn('Failed to initialize tesseract worker:', err?.message || err);
      // If initialization fails, clear worker so future calls can retry, but mark broken if it looks fatal
      try {
        if (worker && typeof worker.terminate === 'function') await worker.terminate();
      } catch (e) {
        // ignore
      }
      // If the error looks like a runtime/internal worker error, avoid repeated retries
      worker = null;
      initPromise = null;
      // Mark as broken if the error originates from the worker internals
      if (err && /worker\.load is not a function|langsArr\.map is not a function|worker thread|kHybridDispatch/i.test(err?.message || '')) {
        workerBroken = true;
      }
      throw err;
    }
  })();
  return initPromise;
}

export async function recognizeBuffer(buffer) {
  try {
    if (workerBroken) return '';
    await initWorker();
    if (!worker) return '';
    // Some tesseract workers expect an ArrayBuffer or Buffer; pass through
    const { data } = await worker.recognize(buffer);
    return data?.text || '';
  } catch (err) {
    console.warn('OCR recognizeBuffer error:', err?.message || err);
    // If recognition step threw and it indicates a worker internal failure, mark broken
    if (err && /langsArr\.map is not a function|worker\.load is not a function|worker thread/i.test(err?.message || '')) {
      workerBroken = true;
      try { if (worker && typeof worker.terminate === 'function') worker.terminate(); } catch (e) { /* noop */ }
      worker = null;
      initPromise = null;
    }
    return '';
  }
}

export async function terminateWorker() {
  try {
    if (worker) {
      await worker.terminate();
      worker = null;
      initPromise = null;
      workerBroken = false;
    }
  } catch (err) {
    console.warn('Failed to terminate tesseract worker:', err?.message || err);
  }
}

export default { recognizeBuffer, terminateWorker, initWorker };
export { initWorker };

export function isWorkerReady() {
  return Boolean(worker && !workerBroken);
}
