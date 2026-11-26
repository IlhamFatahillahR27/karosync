import './style.css';
import {
  getEnvSignalingUrl,
  loadSavedSignalingUrl,
  loadSavedSingerName,
  parseLaunchParams,
  resolveSignalingUrl,
} from './config';
import { MicSession } from './mic-session';
import { KaroSyncMicUI } from './ui';

const appRoot = document.querySelector<HTMLDivElement>('#app');

if (appRoot) {
  const launch = parseLaunchParams(window.location.search);
  const envWs = getEnvSignalingUrl();
  const savedWs = loadSavedSignalingUrl();
  const savedName = loadSavedSingerName();

  const defaultSignalingUrl = resolveSignalingUrl({
    queryWs: launch.querySignalingUrl,
    envWs,
    location: window.location,
  });

  const initialSignalingUrl = resolveSignalingUrl({
    queryWs: launch.querySignalingUrl,
    overrideWs: savedWs,
    envWs,
    location: window.location,
  });

  const session = new MicSession({
    roomId: launch.roomId,
    clientName: savedName,
    signalingUrl: initialSignalingUrl,
  });

  const ui = new KaroSyncMicUI({
    root: appRoot,
    session,
    initialRoomFromQuery: launch.fromQuery,
    defaultSignalingUrl,
  });

  const cleanup = () => {
    session.disconnect('Halaman ditutup.');
    ui.destroy();
  };

  window.addEventListener('pagehide', cleanup);
  window.addEventListener('beforeunload', cleanup);
}
