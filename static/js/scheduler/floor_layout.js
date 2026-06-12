// Factory floor layout — SVG map of machine positions on the shop floor.

const TRIAL_FLOOR_LAYOUT_COLORS = {
  turnmill: '#00B4D8',
  mpp: '#FFB703',
  turning: '#8AB17D',
  milling: '#FF4D4D',
};

const TRIAL_FLOOR_LAYOUT_MACHINES = [
  // Turnmill (top)
  { x: 1, y: 8, w: 2, h: 1.5, label: '38', color: 'turnmill' },
  { x: 4, y: 8, w: 2, h: 1.5, label: '39', color: 'turnmill' },
  { x: 8, y: 7.5, w: 1, h: 2, label: '40', color: 'turnmill', rotation: 90 },
  // MPP (left)
  { x: 0.5, y: 4, w: 1, h: 2.5, label: '35', color: 'mpp', rotation: 90 },
  { x: 0.5, y: 1, w: 1, h: 2.5, label: '36', color: 'mpp', rotation: 90 },
  // Turning (center)
  { x: 2.5, y: 6, w: 1, h: 0.8, label: '30', color: 'turning' },
  { x: 4, y: 6, w: 1, h: 0.8, label: '31', color: 'turning' },
  { x: 5.5, y: 6, w: 1, h: 0.8, label: '32', color: 'turning' },
  { x: 3, y: 4.5, w: 1, h: 0.8, label: '22', color: 'turning' },
  { x: 4.5, y: 4.5, w: 1, h: 0.8, label: '10', color: 'turning' },
  { x: 6.5, y: 4, w: 0.6, h: 1, label: '15', color: 'turning', rotation: 90 },
  { x: 6.5, y: 2.5, w: 0.6, h: 1, label: '21', color: 'turning', rotation: 90 },
  { x: 6, y: 1, w: 1, h: 0.8, label: '24', color: 'turning' },
  // Milling (right column)
  { x: 8.5, y: 6, w: 0.8, h: 1, label: '29', color: 'milling', rotation: 90 },
  { x: 8.5, y: 4.5, w: 0.8, h: 1, label: '20', color: 'milling', rotation: 90 },
  { x: 8.5, y: 3, w: 0.8, h: 1, label: '26', color: 'milling', rotation: 90 },
  { x: 8.5, y: 1.5, w: 0.8, h: 1, label: '25', color: 'milling', rotation: 90 },
  // Machine 27 (turning, bottom right)
  { x: 8.5, y: 0.5, w: 0.8, h: 1, label: '27', color: 'turning', rotation: 90 },
];

function trialFloorLayoutLegendHtml() {
  const items = [
    ['Turnmill', TRIAL_FLOOR_LAYOUT_COLORS.turnmill],
    ['MPP', TRIAL_FLOOR_LAYOUT_COLORS.mpp],
    ['Turning', TRIAL_FLOOR_LAYOUT_COLORS.turning],
    ['Milling', TRIAL_FLOOR_LAYOUT_COLORS.milling],
  ];
  return items.map(([name, color]) => `
    <span class="trial-floor-layout-legend-item">
      <span class="trial-floor-layout-legend-swatch" style="background:${color}"></span>
      ${escapeHtml(name)}
    </span>
  `).join('');
}

function trialFloorLayoutMachineSvg(machine) {
  const fill = TRIAL_FLOOR_LAYOUT_COLORS[machine.color] || '#ccc';
  const cx = machine.x + machine.w / 2;
  const cy = machine.y + machine.h / 2;
  const rotation = Number(machine.rotation) || 0;
  const labelTransform = rotation
    ? ` transform="rotate(${rotation} ${cx} ${cy})"`
    : '';
  return `
    <rect
      x="${machine.x}"
      y="${machine.y}"
      width="${machine.w}"
      height="${machine.h}"
      fill="${fill}"
      stroke="#1a1c1d"
      stroke-width="0.08"
      rx="0.06"
    />
    <text
      x="${cx}"
      y="${cy}"
      text-anchor="middle"
      dominant-baseline="central"
      font-size="0.42"
      font-weight="700"
      fill="#1a1c1d"${labelTransform}
    >${escapeHtml(machine.label)}</text>
  `;
}

function trialFloorLayoutSvgHtml() {
  const machines = TRIAL_FLOOR_LAYOUT_MACHINES.map(trialFloorLayoutMachineSvg).join('');
  return `
    <svg
      class="trial-floor-layout-svg"
      viewBox="0 0 10 10"
      role="img"
      aria-label="Factory floor plan showing machine positions"
    >
      <g transform="scale(1,-1) translate(0,-10)">
        ${machines}
      </g>
    </svg>
  `;
}

function openTrialFloorLayoutModal() {
  if (typeof openModal !== 'function') return;
  openModal('Factory Floor Plan', `
    <div class="trial-floor-layout">
      <div class="trial-floor-layout-legend">${trialFloorLayoutLegendHtml()}</div>
      <div class="trial-floor-layout-map">${trialFloorLayoutSvgHtml()}</div>
    </div>
  `, 'xl');
}
