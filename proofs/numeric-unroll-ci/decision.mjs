// Interpretation only. Statistical cutoffs and estimates stay in unchanged math.mjs.
export function investigationDecision(cells, cases, admitted) {
  const unresolved=cells.filter(c=>c.decision.startsWith('inconclusive')).map(c=>({runtime:c.runtime,case:c.case,flags:c.flags,decision:c.decision}));
  const losses=cells.filter(c=>c.decision==='material loss supported in this cell').map(c=>({runtime:c.runtime,case:c.case}));
  const primaries=new Set(cases.filter(c=>c.primary).map(c=>c.id));
  const gains=cells.filter(c=>primaries.has(c.case) && c.decision==='worthwhile gain supported in this cell').map(c=>({runtime:c.runtime,case:c.case}));
  const disposition=!admitted?'incomplete; no supported screen conclusion':losses.length?'do not advance fixed candidate: supported material loss':gains.length?'bounded further investigation may be worthwhile':'stop this screen: no supported worthwhile primary gain';
  return {disposition,primaryGains:gains,materialLosses:losses,inconclusiveControlsAndCells:unresolved,
    firstUseStatus:'unresolved',promotionAllowed:false,additionalSamplingOrRerunsAuthorized:false};
}
