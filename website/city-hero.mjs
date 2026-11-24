const symbols = {
  school: '<path d="m2 10 10-7 10 7M4 10v11h16V10M10 21v-6h4v6M7 12h1m8 0h1M12 3V1"/>',
  train: '<rect x="5" y="2" width="14" height="16" rx="4"/><path d="M5 10h14M8 21l2-3m6 3-2-3M9 14h1m4 0h1"/>',
  utility: '<path d="m13 2-8 12h6l-1 8 9-13h-7z"/>',
  snapshot: '<path d="m2 8 10-5 10 5-10 5zM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  pause: '<path d="M8 5v14m8-14v14" stroke-width="3"/>',
  play: '<path d="m8 4 11 8-11 8z" fill="currentColor"/>',
  copy: '<path d="M8 7V4h11v13h-3"/><rect x="4" y="8" width="11" height="13" rx="1.5"/>',
};
function icon(name) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${symbols[name]}</svg>`;
}
const jobs = [
  { key: 'school', label: 'School demand', slot: 'W01' },
  { key: 'train', label: 'Train capacity', slot: 'W03' },
  { key: 'utility', label: 'Utility load', slot: 'W06' },
];

// Each folded-paper tower scales up from its own footprint on the same island.
function tower(x, y, scale) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g class="city-tower">
    <path d="m-16-4 16 5 18-9-16-5z" fill="#8d4f23" opacity=".38" transform="translate(5 3)"/>
    <path d="m-15-8 15 5v-38l-15-5z" fill="#efad65"/><path d="m0-3 17-8v-38L0-41z" fill="#c77937"/>
    <path d="m-15-8 15 5 17-8" stroke="#a35c2d" opacity=".55"/><path d="M-14-45v36M0-40v36" stroke="#ffedc2" opacity=".7"/>
    <path d="m-15-46 15 5 17-8-15-5z" fill="#fff0c1"/>
    <path d="m-11-46 10 3 12-6-10-3z" fill="#dc834a"/>
    <path d="m-11-38 8 3m-8 3 8 3m-8 3 8 3m-8 3 8 3m7-15 10-5m-10 11 10-5m-10 11 10-5m-10 11 10-5" fill="none" stroke="#ffe6ac" stroke-width="2" stroke-dasharray="2 1"/>
  </g></g>`;
}

function mapLayers() {
  return `<svg class="city-traces" aria-hidden="true" viewBox="0 0 1672 941" fill="none">
    <path class="district-edge" d="M96 648Q106 613 149 594L260 544Q318 519 394 511L500 466Q537 452 575 470L691 520Q733 536 707 577L684 626Q669 650 623 670L501 710 388 747Q351 759 315 747L160 677Q107 659 96 648Z"/>
    ${tower(578,566,.89)}${tower(608,575,1.08)}${tower(577,581,.97)}${tower(600,591,.82)}
    <g data-job="school" data-state="done"><ellipse cx="705" cy="384" rx="61" ry="22" stroke-dasharray="6 4"/></g>
    <g data-job="train" data-state="done"><path d="M715 507Q763 475 822 485"/><circle cx="715" cy="507" r="7"/><circle cx="822" cy="485" r="7"/></g>
    <g data-job="utility" data-state="done"><path d="M775 559Q830 569 894 560T971 582Q996 610 1088 588" stroke-dasharray="8 5"/><rect x="1007" y="587" width="10" height="10" rx="2"/></g>
  </svg>`;
}

export function cityHero(base) {
  const pins = jobs.map(({ key, label }) => `<div class="city-pin" data-job="${key}" data-state="done">${icon(key)} ${label}<i class="job-mark"></i></div>`).join('');
  const slots = jobs.map(({ key, label, slot }) => `<li class="worker-slot" data-job="${key}" data-state="done">${icon(key)}<span><small>${slot}</small> ${label}</span><i class="job-mark" aria-hidden="true"></i><span class="city-sr job-status">Complete</span></li>`).join('');
  const idle = ['W02', 'W04', 'W05', 'W07', 'W08'].map(slot => `<li class="idle-slot">${slot}<span class="city-sr"> idle</span></li>`).join('');
  return `<section class="city-hero" aria-labelledby="city-title">
    <div class="city-intro">
      <h1 id="city-title"><span class="city-sr">Immutable collections for Node.js workers, Web Workers in the browser, and Bun workers.</span><span aria-hidden="true">Immutable collections<br>for <span class="runtime-slot"><span class="runtime-word">Node.js</span></span> workers.</span></h1>
      <p>Share immutable maps, lists, and sets across workers.</p>
      <div class="city-actions"><a class="quickstart" href="${base}docs/getting-started/">Quickstart <span aria-hidden="true">→</span></a><div class="install-command"><code>npm i zerocopy</code><button type="button" class="copy-install" aria-label="Copy npm install command" hidden>${icon('copy')}</button></div></div>
    </div>
    <div class="city-window" aria-hidden="true"><div class="city-model">
      <img class="city-relief" width="1672" height="941" src="${base}assets/singapore-relief.webp" srcset="${base}assets/singapore-relief-900.webp 900w, ${base}assets/singapore-relief.webp 1672w" sizes="(max-width: 600px) 177vw, (max-width: 980px) 122vw, 100vw" fetchpriority="high" alt="">
      ${mapLayers()}
      <span class="district-pin">30,000 new homes</span>${pins}
    </div></div>
    <p class="city-sr">A proposed district of 30,000 new homes rises in western Singapore. Three workers read the same city snapshot to estimate school demand, train capacity, and utility load beyond the district.</p>
    <div class="worker-strip"><div class="snapshot-key">${icon('snapshot')}<span>1 shared city snapshot</span></div>
      <ul class="worker-list" aria-label="Workers reading the city snapshot">${slots}${idle}</ul>
      <button class="city-playback" type="button" aria-label="Pause animation" hidden><span class="pause-icon">${icon('pause')}</span><span class="play-icon" hidden>${icon('play')}</span></button>
    </div>
  </section>`;
}
