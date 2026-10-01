/**
 * Panel 2A - Pipeline Vectors & Inflow
 * Maps to #panel2A
 */
window.Panel2A = {
  id: 'panel2A',
  title: 'PIPELINE VECTORS',
  badge: 'FLOW 2A',
  
  init(container) {
    container.innerHTML = `
      <div class="panel-content-wrap">
        <div class="gauge-display">
          <div class="gauge-val-group">
            <span class="gauge-number">384.6</span>
            <span class="gauge-unit">MB/SEC</span>
          </div>
          <div class="gauge-track">
            <div class="gauge-fill" style="width: 76%;"></div>
          </div>
        </div>
        <div class="data-tag-row">
          <span class="data-tag">BANDWIDTH: OPTIMAL</span>
          <span class="data-tag">DROP: 0.00%</span>
        </div>
      </div>
    `;
  },

  onResize(width, height) {}
};
