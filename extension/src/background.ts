function configureSidePanelBehavior(): void {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => {
      console.error('[KaroSync Operator] Failed to set side panel behavior:', error);
    });
}

configureSidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelBehavior();
});
