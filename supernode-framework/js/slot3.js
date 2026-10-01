/**
 * Slot 3 - Channel 03 Telemetry
 * Maps to #slot3
 */
window.Slot3 = {
  id: 'slot3',
  title: 'CHANNEL 03',
  badge: 'SYNC',
  init(container) {
    container.innerHTML = `
      <div class="tray-cell-wrap">
        <span class="tray-num">512<small>KB</small></span>
        <span class="tray-desc">Cache Buffer</span>
        <div class="tray-sparkline"><div class="spark-bar" style="height:70%"></div><div class="spark-bar" style="height:65%"></div><div class="spark-bar" style="height:85%"></div><div class="spark-bar" style="height:75%"></div></div>
      </div>
    `;
  }
};
