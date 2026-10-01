/**
 * Slot 4 - Channel 04 Telemetry
 * Maps to #slot4
 */
window.Slot4 = {
  id: 'slot4',
  title: 'CHANNEL 04',
  badge: 'OPTIMAL',
  init(container) {
    container.innerHTML = `
      <div class="tray-cell-wrap">
        <span class="tray-num">0.00<small>%</small></span>
        <span class="tray-desc">Error Rate</span>
        <div class="tray-sparkline"><div class="spark-bar" style="height:20%"></div><div class="spark-bar" style="height:20%"></div><div class="spark-bar" style="height:20%"></div><div class="spark-bar" style="height:20%"></div></div>
      </div>
    `;
  }
};
