import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
  app.innerHTML = `
    <main class="flex min-h-screen flex-col gap-4 p-4">
      <header class="rounded-xl border border-slate-800 bg-slate-900/80 p-4">
        <p class="text-xs font-semibold tracking-widest text-violet-400 uppercase">
          KaroSync Operator
        </p>
        <h1 class="mt-1 text-lg font-bold text-white">Wireless Karaoke Stage</h1>
        <p class="mt-1 text-xs text-slate-400">
          Side Panel scaffold ready for Phase 3 WebRTC mixer &amp; YouTube controls.
        </p>
      </header>
    </main>
  `;
}
