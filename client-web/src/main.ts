import './style.css';

const params = new URLSearchParams(window.location.search);
const roomId = params.get('room')?.trim().toUpperCase() ?? '';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
  app.innerHTML = `
    <main class="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center p-6 text-center">
      <div class="w-full rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
        <p class="text-xs font-semibold tracking-widest text-emerald-400 uppercase">KaroSync Mic</p>
        <h1 class="mt-2 text-2xl font-bold text-white">Wireless Microphone Client</h1>
        <p class="mt-2 text-sm text-slate-400">
          ${roomId ? `Detected Room ID: <span class="font-mono font-semibold text-white">${roomId}</span>` : 'Ready for Phase 2 implementation.'}
        </p>
      </div>
    </main>
  `;
}
