// Factory floor layout — SVG map of machine positions on the shop floor.

const TRIAL_FLOOR_LAYOUT_HEIGHT = 10;

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
  // Right column (bottom to top: 41, 27, 25, 26, 20, 29)
  { x: 8.5, y: 5.7, w: 0.8, h: 1, label: '29', color: 'milling', rotation: 90 },
  { x: 8.5, y: 4.55, w: 0.8, h: 1, label: '20', color: 'milling', rotation: 90 },
  { x: 8.5, y: 3.4, w: 0.8, h: 1, label: '26', color: 'milling', rotation: 90 },
  { x: 8.5, y: 2.25, w: 0.8, h: 1, label: '25', color: 'milling', rotation: 90 },
  { x: 8.5, y: 1.2, w: 0.8, h: 0.9, label: '27', color: 'turning', rotation: 90 },
  { x: 8.5, y: 0.15, w: 0.8, h: 0.9, label: '41', color: 'mpp', rotation: 90 },
];

function trialFloorLayoutMatplotlibToSvg(machine) {
  const { x, y, w, h } = machine;
  return {
    x,
    y: TRIAL_FLOOR_LAYOUT_HEIGHT - y - h,
    w,
    h,
    cx: x + w / 2,
    cy: TRIAL_FLOOR_LAYOUT_HEIGHT - y - h / 2,
  };
}

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
  const { x, y, w, h, cx, cy } = trialFloorLayoutMatplotlibToSvg(machine);
  const mplRot = Number(machine.rotation) || 0;
  const svgRot = mplRot ? -mplRot : 0;
  const labelTransform = svgRot
    ? ` transform="rotate(${svgRot} ${cx} ${cy})"`
    : '';
  return `
    <rect
      x="${x}"
      y="${y}"
      width="${w}"
      height="${h}"
      fill="${fill}"
      stroke="#1a1c1d"
      stroke-width="0.12"
    />
    <text
      x="${cx}"
      y="${cy}"
      text-anchor="middle"
      dominant-baseline="central"
      font-size="0.48"
      font-weight="700"
      fill="#1a1c1d"
      font-family="system-ui, -apple-system, Segoe UI, sans-serif"${labelTransform}
    >${escapeHtml(machine.label)}</text>
  `;
}

function trialFloorLayoutSvgHtml() {
  const machines = TRIAL_FLOOR_LAYOUT_MACHINES.map(trialFloorLayoutMachineSvg).join('');
  return `
    <svg
      class="trial-floor-layout-svg"
      viewBox="0 0 10 10"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Factory floor plan showing machine positions"
    >
      ${machines}
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
