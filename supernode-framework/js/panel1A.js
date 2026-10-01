/**
 * Panel 1A - System Overview & Primary KPIs
 * Maps to #panel1A
 */
window.Panel1A = {
  id: 'panel1A',
  title: 'SYSTEM TELEMETRY',
  badge: 'ONLINE',
  
  init(container) {
    container.innerHTML = `
      <div class="panel-content-wrap">
        <div class="kpi-grid">
          <div class="kpi-cell">
            <span class="kpi-label">Node Efficiency</span>
            <span class="kpi-val highlight">99.4%</span>
            <span class="kpi-sub">Nominal • 0.2ms latency</span>
          </div>
          <div class="kpi-cell">
            <span class="kpi-label">Throughput</span>
            <span class="kpi-val">1,842<small>/s</small></span>
            <span class="kpi-sub">+4.2% vs baseline</span>
          </div>
        </div>
        <div class="status-pill-row">
          <span class="status-indicator live"></span>
          <span class="status-text">Core Cluster: Active (Cluster-01)</span>
        </div>
      </div>
    `;
  },

  onResize(width, height) {
    // Hook called when panel dimensions change via splitters or viewport
  }
};
