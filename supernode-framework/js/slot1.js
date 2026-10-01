/**
 * Slot 1 - Channel 01 Telemetry
 * Maps to #slot1
 */
window.Slot1 = {
  id: 'slot1',
  title: 'CHANNEL 01',
  badge: 'STABLE',
  init(container) {
    container.innerHTML = `
      <div class="tray-cell-wrap">
        <span class="tray-num">98.2<small>%</small></span>
        <span class="tray-desc">Primary Uplink</span>
        <div class="tray-sparkline"><div class="spark-bar" style="height:60%"></div><div class="spark-bar" style="height:80%"></div><div class="spark-bar" style="height:70%"></div><div class="spark-bar" style="height:90%"></div></div>
      </div>
    `;
  }
};
