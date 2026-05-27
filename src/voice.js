export function initVoice({ onScan }) {
  try {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      return { start() {}, stop() {}, supported: false, status: 'unavailable' };
    }

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = false;

    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      const transcript = String(result?.[0]?.transcript || '').toLowerCase();
      if (transcript.includes('k scan') || transcript.includes('scan')) {
        onScan?.();
      }
    };

    recognition.onerror = () => {};

    return {
      start() {
        try { recognition.start(); } catch {}
      },
      stop() {
        try { recognition.stop(); } catch {}
      },
      supported: true,
      status: 'available',
    };
  } catch {
    return { start() {}, stop() {}, supported: false, status: 'disabled' };
  }
}