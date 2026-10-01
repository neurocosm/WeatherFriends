/**
 * Slot 2 - Channel 02 Telemetry
 * Maps to #slot2
 */
window.Slot2 = {
  id: 'slot2',
  title: 'CHANNEL 02',
  badge: 'ACTIVE',
  init(container) {
    container.innerHTML = `
      <div class="tray-cell-wrap">
        <span class="tray-num">1.42<small>ms</small></span>
        <span class="tray-desc">Roundtrip Delay</span>
        <div class="tray-sparkline"><div class="spark-bar" style="height:40%"></div><div class="spark-bar" style="height:55%"></div><div class="spark-bar" style="height:50%"></div><div class="spark-bar" style="height:45%"></div></div>
      </div>
    `;
  }
};
