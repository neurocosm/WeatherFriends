/**
 * Slot 5 - Channel 05 Telemetry
 * Maps to #slot5
 */
window.Slot5 = {
  id: 'slot5',
  title: 'CHANNEL 05',
  badge: 'ONLINE',
  init(container) {
    container.innerHTML = `
      <div class="tray-cell-wrap">
        <span class="tray-num">100<small>%</small></span>
        <span class="tray-desc">Quorum Health</span>
        <div class="tray-sparkline"><div class="spark-bar" style="height:90%"></div><div class="spark-bar" style="height:95%"></div><div class="spark-bar" style="height:92%"></div><div class="spark-bar" style="height:98%"></div></div>
      </div>
    `;
  }
};
