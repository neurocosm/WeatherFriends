/**
 * Panel 1B - Signal Frequency & Activity Stream
 * Maps to #panel1B
 */
window.Panel1B = {
  id: 'panel1B',
  title: 'ACTIVITY STREAM',
  badge: 'SIGNAL 1B',
  
  init(container) {
    container.innerHTML = `
      <div class="panel-content-wrap">
        <div class="mock-chart-container">
          <div class="mock-chart-bars">
            <div class="chart-bar" style="height: 45%;"></div>
            <div class="chart-bar" style="height: 65%;"></div>
            <div class="chart-bar" style="height: 80%;"></div>
            <div class="chart-bar" style="height: 55%;"></div>
            <div class="chart-bar" style="height: 90%;"></div>
            <div class="chart-bar" style="height: 72%;"></div>
            <div class="chart-bar" style="height: 85%;"></div>
            <div class="chart-bar" style="height: 60%;"></div>
            <div class="chart-bar" style="height: 95%;"></div>
            <div class="chart-bar" style="height: 78%;"></div>
          </div>
        </div>
        <div class="chart-legend">
          <span>MIN: 42.0</span>
          <span>AVG: 74.5</span>
          <span>PEAK: 98.2</span>
        </div>
      </div>
    `;
  },

  onResize(width, height) {}
};
