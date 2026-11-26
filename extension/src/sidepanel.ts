import './style.css';
import { OperatorSession } from './operator-session';
import { KaroSyncOperatorUI } from './ui';

const root = document.querySelector<HTMLDivElement>('#app');
if (root) {
  const session = new OperatorSession();
  const ui = new KaroSyncOperatorUI({ root, session });

  const cleanup = () => {
    ui.destroy();
    void session.dispose();
  };

  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
}
